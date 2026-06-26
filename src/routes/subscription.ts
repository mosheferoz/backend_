import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AppEnv } from "../lib/auth.js";
import { rateLimit, rateLimitByUser } from "../lib/rateLimit.js";
import { grow, ChargeType, isGrowSuccess } from "../lib/grow.js";
import {
  isPaidPlan,
  priceFor,
  prorationDelta,
  PLAN_LABELS,
  STORAGE_PACKAGES,
  MAX_TOKEN_CHARGES,
  type PaidPlan,
} from "../lib/plans.js";
import * as billing from "../lib/billing.js";
import { setCancelAtPeriodEnd, getProfileBillingContact } from "../lib/billing.js";
import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { growNotifyUrl, growInvoiceNotifyUrl, successUrl, cancelUrl } from "../lib/urls.js";
import { logger } from "../lib/logger.js";

export const subscriptionRoute = new Hono<AppEnv>();

subscriptionRoute.use("*", rateLimit({ windowMs: 60_000, max: 20, keyPrefix: "sub" }));
subscriptionRoute.use("*", requireAuth);
// Unspoofable per-user cap on the money-mutating endpoints (runs after auth).
subscriptionRoute.use("*", rateLimitByUser({ windowMs: 60_000, max: 30, keyPrefix: "sub-user" }));

const DAY_MS = 24 * 60 * 60 * 1000;

const ChangePlanBody = z.object({ plan: z.enum(["premium", "pro"]) });

/**
 * Change the active plan. Industry-standard behavior:
 *   - During trial: switch immediately, no charge (the first charge at trial
 *     end uses the new plan).
 *   - Upgrade (active, paid): take effect immediately and charge ONLY the
 *     prorated price difference for the unused part of the current period; the
 *     billing anchor (next_billing_at) is preserved.
 *   - Downgrade (active, paid): scheduled to the end of the current period
 *     (pending_plan), no immediate charge and no refund.
 */
subscriptionRoute.post("/change-plan", async (c) => {
  const parsed = ChangePlanBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: false, error: "invalid_request" }, 400);
  const target = parsed.data.plan as PaidPlan;
  const user = c.get("user");

  const { data: sub } = await supabaseAdmin
    .from("subscriptions")
    .select("plan, pending_plan, status, next_billing_at, cancel_at_period_end")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!sub) return c.json({ ok: false, error: "no_subscription" }, 404);
  const current = sub.plan as string;
  const status = sub.status as string;

  // "Upgrade back" / no-op: user is already on the target plan.
  if (current === target) {
    if (sub.pending_plan) {
      await billing.clearPendingPlan(user.id);
      return c.json({ ok: true, effect: "pending_cleared" });
    }
    return c.json({ ok: false, error: "same_plan" }, 400);
  }

  if (status !== "active" && status !== "trialing") {
    return c.json({ ok: false, error: "update_card_required" }, 409);
  }
  if (!isPaidPlan(current)) {
    return c.json({ ok: false, error: "no_paid_plan" }, 400);
  }

  const cycle = Math.max(await billing.countPaidCharges(user.id), 1);
  const isUpgrade = priceFor(target, cycle) > priceFor(current, cycle);

  // --- trial: switch immediately, no charge ---
  if (status === "trialing") {
    await billing.changePlanImmediate(user.id, target);
    logger.info({ userId: user.id, from: current, to: target }, "plan_change_trial");
    return c.json({ ok: true, effect: "immediate_trial" });
  }

  // --- downgrade (active): schedule to period end ---
  if (!isUpgrade) {
    if (sub.cancel_at_period_end) {
      return c.json({ ok: false, error: "cancellation_pending" }, 409);
    }
    await billing.schedulePlanChange(user.id, target);
    logger.info({ userId: user.id, from: current, to: target }, "plan_change_scheduled");
    return c.json({ ok: true, effect: "scheduled_period_end", effectiveAt: sub.next_billing_at });
  }

  // --- upgrade (active): immediate, prorated charge ---
  const nextBilling = sub.next_billing_at ? new Date(sub.next_billing_at as string) : null;
  if (!nextBilling) return c.json({ ok: false, error: "no_billing_anchor" }, 409);
  const now = new Date();
  const daysRemaining = (nextBilling.getTime() - now.getTime()) / DAY_MS;
  if (daysRemaining < 1) {
    // Renewal is imminent — let it bill the new plan at full price instead of a
    // near-zero proration followed immediately by a full charge.
    return c.json({ ok: false, error: "renewal_in_progress" }, 409);
  }
  // Reconstruct the period start (one month before the anchor) with end-of-month
  // clamping, so a 31st-of-month anchor doesn't under/over-count the period
  // length (matches addMonths' clamp in billing.ts).
  const periodStart = new Date(nextBilling);
  const anchorDay = periodStart.getDate();
  periodStart.setDate(1);
  periodStart.setMonth(periodStart.getMonth() - 1);
  const lastDayPrevMonth = new Date(periodStart.getFullYear(), periodStart.getMonth() + 1, 0).getDate();
  periodStart.setDate(Math.min(anchorDay, lastDayPrevMonth));
  const daysInPeriod = (nextBilling.getTime() - periodStart.getTime()) / DAY_MS;

  const pm = await billing.getPaymentMethod(user.id);
  if (!pm || !pm.isValid || !pm.token) {
    return c.json({ ok: false, error: "no_card" }, 409);
  }
  if (pm.chargeCount >= MAX_TOKEN_CHARGES) {
    return c.json({ ok: false, error: "token_charge_limit" }, 409);
  }

  const amount = prorationDelta(current, target, cycle, daysRemaining, daysInPeriod);
  if (amount <= 0) {
    // Nothing to charge (e.g. already at period boundary): just switch.
    await billing.applyUpgrade(user.id, target);
    return c.json({ ok: true, effect: "immediate_no_charge" });
  }

  // Serialize against the renewal job and concurrent upgrades.
  if (!(await billing.claimForUpgrade(user.id))) {
    return c.json({ ok: false, error: "renewal_in_progress" }, 409);
  }

  const uniqueId = await billing.nextUniqueId();
  const contact = await billing.getProfileBillingContact(user.id);
  const description = `שדרוג מסלול ${PLAN_LABELS[current as PaidPlan]} → ${PLAN_LABELS[target]} (חיוב יחסי) — קונטרול בקליק`;

  // Trace before charging — reconcile resolves any 'pending' left behind.
  await billing.recordPayment({
    userId: user.id,
    plan: target,
    amount,
    transactionUniqueId: uniqueId,
    kind: "upgrade",
    status: "pending",
  });

  const res = await grow.createTransactionWithToken({
    cardToken: pm.token,
    sum: amount,
    description,
    fullName: contact.fullName,
    phone: contact.phone,
    email: contact.email ?? undefined,
    transactionUniqueIdentifier: uniqueId,
    invoiceNotifyUrl: growInvoiceNotifyUrl(),
    invoiceName: contact.businessName ?? contact.fullName,
    invoiceLicenseNumber: contact.businessId ?? undefined,
    cField1: user.id,
    cField2: target,
    cField3: "upgrade",
  });

  if (isGrowSuccess(res)) {
    const dd = (res.data ?? {}) as Record<string, unknown>;
    await billing.applyUpgrade(user.id, target);
    await billing.incrementChargeCount(user.id);
    await billing.finalizePayment(uniqueId, {
      status: "success",
      providerTxnId: dd.transactionId ? String(dd.transactionId) : null,
      asmachta: dd.asmachta ? String(dd.asmachta) : null,
      cardSuffix: (dd.cardSuffix as string) ?? pm.cardSuffix,
      cardBrand: (dd.cardBrand as string) ?? null,
    });
    logger.info({ userId: user.id, from: current, to: target, amount }, "plan_upgrade_charged");
    return c.json({ ok: true, effect: "upgraded", proratedAmount: amount });
  }

  // Transport uncertainty — the prorated charge MAY have gone through. Leave the
  // payment row 'pending' (do NOT mark failed) so the reconcile job resolves it
  // via a Grow query and applies the upgrade if it actually succeeded — never
  // charging twice. The plan stays unchanged until then. (Mirrors renew.ts.)
  if (res.err?.message === "network_error" || res.err?.message === "invalid_json") {
    logger.warn({ userId: user.id, target, uniqueId }, "plan_upgrade_uncertain_left_pending");
    return c.json({ ok: false, error: "charge_uncertain" }, 502);
  }

  // Definitive failure — leave the plan untouched, NO dunning.
  await billing.finalizePayment(uniqueId, {
    status: "failed",
    errorText: res.err?.message ?? "upgrade_charge_failed",
  });
  logger.warn({ userId: user.id, target, err: res.err }, "plan_upgrade_failed");
  return c.json({ ok: false, error: "charge_failed" }, 502);
});

subscriptionRoute.post("/cancel", async (c) => {
  await setCancelAtPeriodEnd(c.get("user").id, true);
  return c.json({ ok: true });
});

subscriptionRoute.post("/resume", async (c) => {
  await setCancelAtPeriodEnd(c.get("user").id, false);
  return c.json({ ok: true });
});

/** Issue a fresh hosted form to replace the saved card (dunning / expiry). */
subscriptionRoute.post("/update-card", async (c) => {
  const user = c.get("user");
  const { data: sub } = await supabaseAdmin
    .from("subscriptions")
    .select("plan")
    .eq("user_id", user.id)
    .maybeSingle();
  const plan = sub?.plan;
  if (!isPaidPlan(plan)) return c.json({ ok: false, error: "no_paid_plan" }, 400);

  const contact = await getProfileBillingContact(user.id);
  const res = await grow.createPaymentProcess({
    chargeType: ChargeType.SAVE_TOKEN_ONLY,
    // Card replacement saves the token only (no charge). Grow rejects sum=0, so
    // we show a ₪1 validation reference — NOT the plan price — to avoid implying
    // a charge is being made (consumer-transparency; mirrors the trial flow).
    sum: 1,
    description: `עדכון אמצעי תשלום — אימות כרטיס בלבד, לא יבוצע חיוב (קונטרול בקליק)`,
    fullName: contact.fullName,
    phone: contact.phone,
    email: contact.email ?? user.email ?? undefined,
    successUrl: successUrl(plan, "update-card"),
    cancelUrl: cancelUrl(),
    notifyUrl: growNotifyUrl(),
    invoiceNotifyUrl: growInvoiceNotifyUrl(),
    saveToken: true,
    cField1: user.id,
    cField2: plan,
    cField3: "update_card",
  });
  if (!isGrowSuccess(res) || !res.data?.url) return c.json({ ok: false, error: "init_failed" }, 502);
  return c.json({ ok: true, url: res.data.url });
});

/**
 * 14-day cooling-off refund (consumer protection). Refunds the user's most
 * recent successful paid charge if it's within REFUND_WINDOW_DAYS and not
 * already refunded, then downgrades to free immediately. Charges made before
 * refund support shipped (no stored token) return not_refundable → support.
 */
const REFUND_WINDOW_DAYS = 14;
subscriptionRoute.post("/refund", async (c) => {
  const user = c.get("user");
  const charge = await billing.getRefundableCharge(user.id);
  if (!charge) return c.json({ ok: false, error: "not_refundable" }, 409);

  const ageDays = (Date.now() - new Date(charge.createdAt).getTime()) / DAY_MS;
  if (ageDays > REFUND_WINDOW_DAYS) {
    return c.json({ ok: false, error: "window_passed" }, 409);
  }

  const res = await grow.refundTransaction({
    transactionId: charge.providerTxnId,
    transactionToken: charge.providerTxnToken,
    refundSum: charge.amount,
    stopDirectDebit: true,
  });
  if (!isGrowSuccess(res)) {
    logger.warn({ userId: user.id, err: res.err }, "refund_failed");
    return c.json({ ok: false, error: "refund_failed" }, 502);
  }

  await billing.recordRefund({
    userId: user.id,
    plan: charge.plan,
    amount: charge.amount,
    refundedTxnId: charge.providerTxnId,
  });
  await billing.downgradeToFreeImmediate(user.id);
  logger.info({ userId: user.id, amount: charge.amount }, "refund_completed");
  return c.json({ ok: true, refundedAmount: charge.amount });
});

/**
 * One-time paid storage add-on (D2). Charges the saved card token for the
 * package price and, only on a verified success, grants the GB via a
 * service-role RPC. Requires a saved card (subscribe first to store one).
 */
const StoragePurchaseBody = z.object({ gb: z.number().int() });
subscriptionRoute.post("/storage-purchase", async (c) => {
  const parsed = StoragePurchaseBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: false, error: "invalid_request" }, 400);
  const gb = parsed.data.gb;
  const price = STORAGE_PACKAGES[gb];
  if (!price) return c.json({ ok: false, error: "invalid_package" }, 400);
  const user = c.get("user");

  const pm = await billing.getPaymentMethod(user.id);
  if (!pm || !pm.isValid || !pm.token) return c.json({ ok: false, error: "no_card" }, 409);
  if (pm.chargeCount >= MAX_TOKEN_CHARGES) {
    return c.json({ ok: false, error: "token_charge_limit" }, 409);
  }

  const uniqueId = await billing.nextUniqueId();
  const contact = await billing.getProfileBillingContact(user.id);
  const planTag = `storage_${gb}gb`;
  const description = `רכישת אחסון ${gb}GB — קונטרול בקליק`;

  await billing.recordPayment({
    userId: user.id,
    plan: planTag,
    amount: price,
    transactionUniqueId: uniqueId,
    kind: "storage_addon",
    status: "pending",
  });

  const res = await grow.createTransactionWithToken({
    cardToken: pm.token,
    sum: price,
    description,
    fullName: contact.fullName,
    phone: contact.phone,
    email: contact.email ?? undefined,
    transactionUniqueIdentifier: uniqueId,
    invoiceNotifyUrl: growInvoiceNotifyUrl(),
    invoiceName: contact.businessName ?? contact.fullName,
    invoiceLicenseNumber: contact.businessId ?? undefined,
    cField1: user.id,
    cField2: planTag,
    cField3: "storage_addon",
  });

  if (isGrowSuccess(res)) {
    const dd = (res.data ?? {}) as Record<string, unknown>;
    await billing.grantStoragePurchase(user.id, gb);
    await billing.incrementChargeCount(user.id);
    await billing.finalizePayment(uniqueId, {
      status: "success",
      providerTxnId: dd.transactionId ? String(dd.transactionId) : null,
      asmachta: dd.asmachta ? String(dd.asmachta) : null,
    });
    logger.info({ userId: user.id, gb, price }, "storage_purchase_charged");
    return c.json({ ok: true, gb, amount: price });
  }

  // Failure or transport-uncertain: do NOT grant. (Uncertain leaves a 'pending'
  // ledger row for manual review — storage add-ons are not auto-reconciled.)
  if (res.err?.message === "network_error" || res.err?.message === "invalid_json") {
    logger.warn({ userId: user.id, gb, uniqueId }, "storage_purchase_uncertain");
    return c.json({ ok: false, error: "charge_uncertain" }, 502);
  }
  await billing.finalizePayment(uniqueId, {
    status: "failed",
    errorText: res.err?.message ?? "storage_charge_failed",
  });
  return c.json({ ok: false, error: "charge_failed" }, 502);
});
