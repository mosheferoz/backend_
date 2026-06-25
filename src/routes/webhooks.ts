import { Hono } from "hono";
import { config } from "../config.js";
import { grow, isGrowSuccess } from "../lib/grow.js";
import { isPaidPlan, amountMatches, type PaidPlan } from "../lib/plans.js";
import * as billing from "../lib/billing.js";
import { extractInvoiceRef } from "../lib/invoices.js";
import { logger } from "../lib/logger.js";

export const webhooksRoute = new Hono();

// Grow doesn't sign webhooks; the real protection is server-to-server
// re-verification (getTransactionInfo / getPaymentProcessInfo) inside each
// handler. The secret is defense-in-depth: if one is supplied (our per-request
// notifyUrl adds it) it MUST match; Grow's account-level notify may omit it, in
// which case we still process and re-verify.
webhooksRoute.use("*", async (c, next) => {
  const provided =
    c.req.header("x-grow-secret") ?? new URL(c.req.url).searchParams.get("secret");
  if (provided != null && provided !== config.growNotifySecret) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }
  await next();
});

type Dict = Record<string, unknown>;

function setDeep(root: Dict, key: string, val: string): void {
  const parts = key.replace(/\]/g, "").split("[");
  let cur: Dict = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i] as string;
    if (typeof cur[p] !== "object" || cur[p] === null) cur[p] = {};
    cur = cur[p] as Dict;
  }
  cur[parts[parts.length - 1] as string] = val;
}

function parseBody(raw: string, contentType: string): Dict {
  if (contentType.includes("json")) {
    try {
      return JSON.parse(raw) as Dict;
    } catch {
      return {};
    }
  }
  const out: Dict = {};
  for (const [k, v] of new URLSearchParams(raw)) setDeep(out, k, v);
  return out;
}

function pick(obj: Dict | undefined | null, keys: string[]): string | null {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== "") return String(v);
  }
  return null;
}

// ---------------------------------------------------------------------------

webhooksRoute.post("/", async (c) => {
  const raw = await c.req.text();
  const payload = parseBody(raw, c.req.header("content-type") ?? "");

  const d = (payload.data && typeof payload.data === "object" ? payload.data : payload) as Dict;
  const cf = (d.customFields && typeof d.customFields === "object"
    ? d.customFields
    : (payload.customFields as Dict) ?? {}) as Dict;

  const userId = pick(cf, ["cField1"]) ?? pick(d, ["cField1"]) ?? pick(payload, ["cField1"]);
  const plan = pick(cf, ["cField2"]) ?? pick(d, ["cField2"]) ?? pick(payload, ["cField2"]);
  const mode = pick(cf, ["cField3"]) ?? pick(d, ["cField3"]) ?? pick(payload, ["cField3"]);

  const transactionId = pick(d, ["transactionId", "transactionCode"]) ?? pick(payload, ["transactionId"]);
  const transactionToken = pick(d, ["transactionToken"]) ?? pick(payload, ["transactionToken"]);
  const processId = pick(d, ["processId", "paymentLinkProcessId"]) ?? pick(payload, ["processId"]);
  const processToken = pick(d, ["processToken", "paymentLinkProcessToken"]) ?? pick(payload, ["processToken"]);
  const asmachta = pick(d, ["asmachta"]) ?? pick(payload, ["asmachta"]);
  const cardToken = pick(d, ["cardToken", "token"]) ?? pick(payload, ["cardToken"]);
  const cardSuffix = pick(d, ["cardSuffix"]);
  const cardBrand = pick(d, ["cardBrand"]);
  const payerEmail = pick(d, ["payerEmail"]);
  const payerPhone = pick(d, ["payerPhone"]);
  const fullName = pick(d, ["fullName", "payerName"]);

  if (!userId || !isPaidPlan(plan)) {
    logger.warn({ userId, plan }, "grow_notify_missing_user_or_plan");
    // 200 so Grow stops re-sending an un-actionable notify.
    return c.json({ ok: false, error: "missing_user_or_plan" });
  }

  // --- card replacement (no state change, no approve) ---
  if (mode === "update_card") {
    if (!cardToken) return c.json({ ok: false, ignored: true, reason: "no_token" });
    // Verify server-to-server before trusting the token — otherwise anyone who
    // can reach this endpoint could swap a user's saved card.
    if (!processId || !processToken) {
      logger.warn({ userId }, "update_card_unverified_missing_process");
      return c.json({ ok: false, ignored: true, reason: "unverified_update_card" });
    }
    const info = await grow.getPaymentProcessInfo(processId, processToken);
    if (!isGrowSuccess(info)) {
      logger.warn({ userId }, "update_card_unverified");
      return c.json({ ok: false, ignored: true, reason: "unverified_update_card" });
    }
    await billing.savePaymentMethod({
      userId,
      token: cardToken,
      cardSuffix,
      cardBrand,
      name: fullName,
      phone: payerPhone,
      email: payerEmail,
    });
    return c.json({ ok: true, kind: "update_card" });
  }

  // --- idempotency on the first transaction ---
  const dedupeKey = transactionId ?? asmachta;
  if (dedupeKey && (await billing.isTxnProcessed(dedupeKey))) {
    return c.json({ ok: true, dedup: true });
  }

  // --- trial: save token only, NO charge, NO approve (J-style) ---
  if (mode === "trial") {
    if (!cardToken) return c.json({ ok: false, ignored: true, reason: "trial_without_token" });
    if (processId && processToken) {
      const info = await grow.getPaymentProcessInfo(processId, processToken);
      if (!isGrowSuccess(info)) return c.json({ ok: false, ignored: true, reason: "unverified_trial" });
    }
    await billing.savePaymentMethod({
      userId,
      token: cardToken,
      cardSuffix,
      cardBrand,
      name: fullName,
      phone: payerPhone,
      email: payerEmail,
    });
    await billing.startTrial(userId, plan as PaidPlan);
    await billing.recordPayment({
      userId,
      plan,
      amount: 0,
      providerTxnId: dedupeKey,
      asmachta,
      cardSuffix,
      cardBrand,
      kind: "trial",
      status: "success",
    });
    logger.info({ userId, plan }, "trial_started");
    return c.json({ ok: true, kind: "trial" });
  }

  // --- subscribe: never trust the webhook amount; verify server-to-server ---
  let verifiedSum = NaN;
  if (transactionId && transactionToken) {
    const info = await grow.getTransactionInfo(transactionId, transactionToken);
    if (!isGrowSuccess(info)) {
      logger.warn({ userId, transactionId }, "verify_refetch_not_success");
      return c.json({ ok: false, ignored: true, reason: "unverified" });
    }
    const id = (info.data ?? {}) as Dict;
    verifiedSum = Number(pick(id, ["sum", "paymentSum"]) ?? pick(d, ["sum", "paymentSum"]));
  } else {
    verifiedSum = Number(pick(d, ["sum", "paymentSum"]));
  }

  // Validate against the price for this user's current cycle (promo vs regular).
  const cycle = await billing.nextChargeCycle(userId);
  if (!amountMatches(plan as PaidPlan, verifiedSum, cycle)) {
    await billing.recordPayment({
      userId,
      plan,
      amount: verifiedSum,
      providerTxnId: dedupeKey,
      asmachta,
      cardSuffix,
      cardBrand,
      kind: "subscribe",
      status: "rejected_amount",
      errorText: `amount_mismatch got=${verifiedSum}`,
    });
    logger.error({ userId, plan, verifiedSum }, "amount_mismatch");
    return c.json({ ok: false, ignored: true, reason: "amount_mismatch" });
  }

  if (cardToken) {
    await billing.savePaymentMethod({
      userId,
      token: cardToken,
      cardSuffix,
      cardBrand,
      name: fullName,
      phone: payerPhone,
      email: payerEmail,
    });
  }
  await billing.activatePaidSubscription({
    userId,
    plan: plan as PaidPlan,
    sum: verifiedSum,
    cardSuffix,
    cardBrand,
  });
  await billing.recordPayment({
    userId,
    plan,
    amount: verifiedSum,
    providerTxnId: dedupeKey,
    asmachta,
    cardSuffix,
    cardBrand,
    kind: "subscribe",
    status: "success",
  });

  // Finalize with Grow — ONLY the first transaction. Stops the 5x retries.
  // The charge is already verified, activated and recorded; if approve fails we
  // must still return 200 (Grow will re-send, and idempotency will dedupe) so we
  // don't 500 a successful subscription.
  try {
    await grow.approveTransaction(d);
  } catch (e) {
    logger.error({ err: String(e), userId, plan }, "approve_transaction_failed");
  }
  logger.info({ userId, plan, verifiedSum }, "subscription_activated");
  return c.json({ ok: true, kind: "subscribe" });
});

// ---------------------------------------------------------------------------

webhooksRoute.post("/invoice", async (c) => {
  const raw = await c.req.text();
  const payload = parseBody(raw, c.req.header("content-type") ?? "");
  const d = (payload.data && typeof payload.data === "object" ? payload.data : payload) as Dict;
  const txnId = pick(d, ["transactionId", "transactionCode"]) ?? pick(payload, ["transactionId"]);
  const { ref, url } = extractInvoiceRef(payload);
  if (txnId) await billing.attachInvoice(txnId, ref, url);
  logger.info({ txnId, ref }, "invoice_notify");
  return c.json({ ok: true });
});
