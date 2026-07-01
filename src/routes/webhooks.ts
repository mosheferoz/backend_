import { Hono } from "hono";
import { config } from "../config.js";
import { grow } from "../lib/grow.js";
import { isPaidPlan, amountMatches, type PaidPlan } from "../lib/plans.js";
import * as billing from "../lib/billing.js";
import { confirmRedemption, applyCouponCycle } from "../lib/coupons.js";
import { extractInvoiceRef } from "../lib/invoices.js";
import { rateLimit } from "../lib/rateLimit.js";
import { safeEqual } from "../lib/crypto.js";
import { alertAdmin } from "../lib/mail.js";
import { logger } from "../lib/logger.js";

export const webhooksRoute = new Hono();

// Generous per-IP throttle (defense-in-depth) against scripted abuse.
webhooksRoute.use("*", rateLimit({ windowMs: 60_000, max: 100, keyPrefix: "webhook" }));

// Authenticity gate: every notify MUST carry our shared secret. We register the
// notifyUrl (and invoiceNotifyUrl) with `?secret=<GROW_NOTIFY_SECRET>`, so Grow
// echoes it on every callback. This is the authenticity guard — once it passes,
// handlers TRUST the notify payload directly. Per Grow's guidance, the pull-style
// calls (getTransactionInfo / getPaymentProcessInfo) are for reconciliation ONLY
// (when a notify did not arrive) and must NOT be used as routine verification.
webhooksRoute.use("*", async (c, next) => {
  const provided =
    c.req.header("x-grow-secret") ?? new URL(c.req.url).searchParams.get("secret");
  if (!safeEqual(provided, config.growNotifySecret)) {
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
  const redemptionId = pick(cf, ["cField4"]) ?? pick(d, ["cField4"]) ?? pick(payload, ["cField4"]);

  const transactionId = pick(d, ["transactionId", "transactionCode"]) ?? pick(payload, ["transactionId"]);
  const transactionToken = pick(d, ["transactionToken"]) ?? pick(payload, ["transactionToken"]);
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
  // The notify is authenticated by the shared secret above, so we trust it and
  // save the new card token — no getPaymentProcessInfo pull (reconciliation-only).
  if (mode === "update_card") {
    if (!cardToken) return c.json({ ok: false, ignored: true, reason: "no_token" });
    await billing.savePaymentMethod({
      userId,
      token: cardToken,
      cardSuffix,
      cardBrand,
      name: fullName,
      phone: payerPhone,
      email: payerEmail,
    });
    // Re-arm renewals: a card replaced during dunning must not stay excluded
    // from the renewal job (failed_charge_count >= 3) and get downgraded.
    await billing.clearDunningOnCardUpdate(userId);
    return c.json({ ok: true, kind: "update_card" });
  }

  // --- idempotency on the first transaction ---
  const dedupeKey = transactionId ?? asmachta;
  if (dedupeKey && (await billing.isTxnProcessed(dedupeKey))) {
    return c.json({ ok: true, dedup: true });
  }

  // --- trial: save token only, NO charge, NO approve (J-style) ---
  // The notify is authenticated by the shared secret above, so we trust it; no
  // getPaymentProcessInfo pull (that call is reconciliation-only, per Grow).
  if (mode === "trial") {
    if (!cardToken) return c.json({ ok: false, ignored: true, reason: "trial_without_token" });
    await billing.savePaymentMethod({
      userId,
      token: cardToken,
      cardSuffix,
      cardBrand,
      name: fullName,
      phone: payerPhone,
      email: payerEmail,
    });
    // No charge happens here, so there's nothing to validate a coupon amount
    // against yet — just confirm the reservation and attach it to the trial so
    // the renewal job can find and apply it at the real trial-conversion charge.
    const trialDiscount = redemptionId ? await confirmRedemption(redemptionId, userId) : null;
    await billing.startTrial(userId, plan as PaidPlan, trialDiscount ? redemptionId : null);
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

  // --- subscribe: the notify is authenticated by the shared secret, so we trust
  // the amount it reports (no getTransactionInfo pull — that's reconciliation
  // only, per Grow). amountMatches still guards against a wrong/misconfigured
  // amount (e.g. VAT added on top) for the user's current cycle. ---
  const verifiedSum = Number(pick(d, ["sum", "paymentSum"]));

  // Resolve any coupon BEFORE validating the amount — confirmRedemption is
  // scoped to this userId, so a spoofed/mismatched cField4 just yields no
  // discount (full price required) rather than granting someone else's
  // coupon. A broken redemption reference can only make this check stricter,
  // never looser.
  const discount = redemptionId ? await confirmRedemption(redemptionId, userId) : null;

  // Validate against the price for this user's current cycle (promo vs
  // regular, discounted if a coupon applies).
  const cycle = await billing.nextChargeCycle(userId);
  if (!amountMatches(plan as PaidPlan, verifiedSum, cycle, discount)) {
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
    await alertAdmin("amount_mismatch (possible tampering)", { userId, plan, verifiedSum, cycle });
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
    couponRedemptionId: discount ? redemptionId : null,
  });
  if (discount && redemptionId) await applyCouponCycle(redemptionId);
  await billing.recordPayment({
    userId,
    plan,
    amount: verifiedSum,
    providerTxnId: dedupeKey,
    providerTxnToken: transactionToken,
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
  const asmachta = pick(d, ["asmachta"]) ?? pick(payload, ["asmachta"]);
  const { ref, url } = extractInvoiceRef(payload);
  if (txnId || asmachta) {
    await billing.attachInvoice(txnId ?? undefined, asmachta ?? undefined, ref, url);
  }
  logger.info({ txnId, asmachta, ref }, "invoice_notify");
  return c.json({ ok: true });
});
