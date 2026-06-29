import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "./supabaseAdmin.js";
import { encryptToken, decryptToken } from "./crypto.js";
import { GRACE_DAYS, TRIAL_DAYS, isPaidPlan, type PaidPlan } from "./plans.js";
import { sendEmail, dunningHtml } from "./mail.js";
import { logger } from "./logger.js";

// --- date helpers (calendar-correct month/day math) ---
function addMonths(d: Date, n: number): Date {
  const x = new Date(d);
  const day = x.getDate();
  // Move on the 1st to avoid JS overflow (Jan 31 + 1m would roll into March),
  // then clamp to the last valid day of the target month (-> Feb 28/29).
  x.setDate(1);
  x.setMonth(x.getMonth() + n);
  const lastDayOfMonth = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate();
  x.setDate(Math.min(day, lastDayOfMonth));
  return x;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
const iso = (d: Date) => d.toISOString();

// ---------------------------------------------------------------------------
// Payment methods (card token vault)
// ---------------------------------------------------------------------------

export interface SavePaymentMethodInput {
  userId: string;
  token: string;
  cardSuffix?: string | null;
  cardBrand?: string | null;
  cardExp?: string | null;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
}

/** Store/replace the user's card token (encrypted). A new card resets charge_count. */
export async function savePaymentMethod(i: SavePaymentMethodInput): Promise<void> {
  const { error } = await supabaseAdmin.from("payment_methods").upsert(
    {
      user_id: i.userId,
      provider: "grow",
      card_token: encryptToken(i.token),
      card_suffix: i.cardSuffix ?? null,
      card_brand: i.cardBrand ?? null,
      card_exp: i.cardExp ?? null,
      customer_name: i.name ?? null,
      customer_phone: i.phone ?? null,
      customer_email: i.email ?? null,
      charge_count: 0,
      is_valid: true,
      is_default: true,
      updated_at: iso(new Date()),
    },
    { onConflict: "user_id" },
  );
  if (error) throw new Error(`savePaymentMethod: ${error.message}`);
}

export interface DecryptedPaymentMethod {
  userId: string;
  token: string;
  cardSuffix: string | null;
  cardBrand: string | null;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  chargeCount: number;
  isValid: boolean;
}

export async function getPaymentMethod(userId: string): Promise<DecryptedPaymentMethod | null> {
  const { data, error } = await supabaseAdmin
    .from("payment_methods")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`getPaymentMethod: ${error.message}`);
  if (!data) return null;
  return {
    userId: data.user_id,
    token: decryptToken(data.card_token),
    cardSuffix: data.card_suffix ?? null,
    cardBrand: data.card_brand ?? null,
    customerName: data.customer_name ?? null,
    customerPhone: data.customer_phone ?? null,
    customerEmail: data.customer_email ?? null,
    chargeCount: data.charge_count ?? 0,
    isValid: data.is_valid ?? false,
  };
}

export async function incrementChargeCount(userId: string): Promise<void> {
  // Atomic increment via SQL RPC to avoid read-modify-write races.
  const { error } = await supabaseAdmin.rpc("increment_charge_count", { p_user_id: userId });
  if (error) logger.error({ err: error.message, userId }, "increment_charge_count_failed");
}

export async function invalidatePaymentMethod(userId: string): Promise<void> {
  await supabaseAdmin.from("payment_methods").update({ is_valid: false }).eq("user_id", userId);
}

// ---------------------------------------------------------------------------
// Subscription lifecycle (always UPDATE — every user already has a row)
// ---------------------------------------------------------------------------

/** First paid activation (subscribe). Period = 1 month + grace. */
export async function activatePaidSubscription(i: {
  userId: string;
  plan: PaidPlan;
  sum: number;
  cardSuffix?: string | null;
  cardBrand?: string | null;
}): Promise<void> {
  const now = new Date();
  const nextBilling = addMonths(now, 1);
  const { error } = await supabaseAdmin
    .from("subscriptions")
    .update({
      plan: i.plan,
      status: "active",
      purchased_at: iso(now),
      next_billing_at: iso(nextBilling),
      expires_at: iso(addDays(nextBilling, GRACE_DAYS)),
      auto_renew: true,
      cancel_at_period_end: false,
      // Clear any stale scheduled downgrade from a prior subscription lifecycle
      // so a re-subscribe doesn't silently re-apply it on the next renewal.
      pending_plan: null,
      failed_charge_count: 0,
      dunning_status: null,
      dunning_warned_at: null,
      last_payment_at: iso(now),
      last_payment_amount: i.sum,
      card_suffix: i.cardSuffix ?? null,
      card_brand: i.cardBrand ?? null,
      // No charge is in flight after activation — leave the renewal-claim stamp
      // clear so an immediate upgrade (claimForUpgrade) isn't blocked for ~50min.
      last_charge_attempt_at: null,
      updated_at: iso(now),
    })
    .eq("user_id", i.userId);
  if (error) throw new Error(`activatePaidSubscription: ${error.message}`);
}

/**
 * Renewal success — extend the period; clear dunning state. When `newPlan` is
 * given (a scheduled downgrade taking effect), the plan is switched and the
 * pending flag cleared in the same atomic UPDATE.
 */
export async function renewSubscription(
  userId: string,
  sum: number,
  newPlan?: PaidPlan,
): Promise<void> {
  const now = new Date();
  // Anchor the next charge to the PREVIOUS billing date, not the execution time,
  // so the billing day-of-month stays stable instead of drifting forward a bit
  // every cycle. If we're catching up late, roll forward until it's in the future.
  const { data: cur } = await supabaseAdmin
    .from("subscriptions")
    .select("next_billing_at")
    .eq("user_id", userId)
    .maybeSingle();
  const prevAnchor = cur?.next_billing_at ? new Date(cur.next_billing_at as string) : now;
  let nextBilling = addMonths(prevAnchor, 1);
  while (nextBilling.getTime() <= now.getTime()) nextBilling = addMonths(nextBilling, 1);
  const { error } = await supabaseAdmin
    .from("subscriptions")
    .update({
      status: "active",
      next_billing_at: iso(nextBilling),
      expires_at: iso(addDays(nextBilling, GRACE_DAYS)),
      failed_charge_count: 0,
      dunning_status: null,
      dunning_warned_at: null,
      last_payment_at: iso(now),
      last_payment_amount: sum,
      last_charge_attempt_at: iso(now),
      ...(newPlan ? { plan: newPlan, pending_plan: null } : {}),
      updated_at: iso(now),
    })
    .eq("user_id", userId);
  if (error) throw new Error(`renewSubscription: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Plan changes (upgrade / downgrade / trial switch)
// ---------------------------------------------------------------------------

/**
 * Apply an immediate upgrade after a successful proration charge: switch the
 * plan now WITHOUT touching the billing anchor (next_billing_at / expires_at).
 * The next renewal bills the full new-plan price.
 */
export async function applyUpgrade(userId: string, newPlan: PaidPlan): Promise<void> {
  const { error } = await supabaseAdmin
    .from("subscriptions")
    .update({ plan: newPlan, pending_plan: null, updated_at: iso(new Date()) })
    .eq("user_id", userId);
  if (error) throw new Error(`applyUpgrade: ${error.message}`);
}

/**
 * Change the plan immediately with no charge — used during the free trial,
 * where the eventual first charge at trial end uses whatever plan is set then.
 * Keeps trial_ends_at / trial_used / next_billing_at intact.
 */
export async function changePlanImmediate(userId: string, newPlan: PaidPlan): Promise<void> {
  const { error } = await supabaseAdmin
    .from("subscriptions")
    .update({ plan: newPlan, pending_plan: null, updated_at: iso(new Date()) })
    .eq("user_id", userId);
  if (error) throw new Error(`changePlanImmediate: ${error.message}`);
}

/** Schedule a downgrade to take effect at the next renewal (period end). */
export async function schedulePlanChange(userId: string, pendingPlan: PaidPlan): Promise<void> {
  const { error } = await supabaseAdmin
    .from("subscriptions")
    .update({ pending_plan: pendingPlan, updated_at: iso(new Date()) })
    .eq("user_id", userId);
  if (error) throw new Error(`schedulePlanChange: ${error.message}`);
}

/** Cancel a scheduled (pending) plan change — e.g. user upgrades back. */
export async function clearPendingPlan(userId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("subscriptions")
    .update({ pending_plan: null, updated_at: iso(new Date()) })
    .eq("user_id", userId);
  if (error) throw new Error(`clearPendingPlan: ${error.message}`);
}

/**
 * Atomically claim the subscription for an immediate upgrade charge by stamping
 * the same `last_charge_attempt_at` window the renewal job uses. Succeeds only
 * if the row is not already claimed — this serializes concurrent upgrades and
 * keeps the renewal job from racing the proration charge. Returns false if busy.
 */
export async function claimForUpgrade(userId: string): Promise<boolean> {
  const now = new Date();
  const windowIso = iso(new Date(now.getTime() - 50 * 60_000));
  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .update({ last_charge_attempt_at: iso(now) })
    .eq("user_id", userId)
    .or(`last_charge_attempt_at.is.null,last_charge_attempt_at.lt.${windowIso}`)
    .select("user_id")
    .maybeSingle();
  if (error) throw new Error(`claimForUpgrade: ${error.message}`);
  return !!data;
}

/** Start the free trial (save-token-only flow). No charge. */
export async function startTrial(userId: string, plan: PaidPlan): Promise<void> {
  const now = new Date();
  const trialEnds = addDays(now, TRIAL_DAYS);
  const { error } = await supabaseAdmin
    .from("subscriptions")
    .update({
      plan,
      status: "trialing",
      trial_ends_at: iso(trialEnds),
      trial_used: true,
      next_billing_at: iso(trialEnds),
      expires_at: iso(trialEnds),
      auto_renew: true,
      cancel_at_period_end: false,
      failed_charge_count: 0,
      dunning_status: null,
      updated_at: iso(now),
    })
    .eq("user_id", userId);
  if (error) throw new Error(`startTrial: ${error.message}`);
}

/** Renewal failure — enter dunning (short grace). cardDead => stop retrying. */
export async function recordRenewalFailure(
  userId: string,
  errorText: string,
  cardDead: boolean,
): Promise<void> {
  const now = new Date();
  const { data } = await supabaseAdmin
    .from("subscriptions")
    .select("failed_charge_count")
    .eq("user_id", userId)
    .maybeSingle();
  const count = (data?.failed_charge_count ?? 0) + 1;
  await supabaseAdmin
    .from("subscriptions")
    .update({
      status: "past_due",
      failed_charge_count: count,
      dunning_status: cardDead ? "card_invalid" : "retrying",
      last_charge_attempt_at: iso(now),
      updated_at: iso(now),
    })
    .eq("user_id", userId);
  if (cardDead) await invalidatePaymentMethod(userId);
  logger.warn({ userId, count, cardDead, errorText }, "renewal_failure");

  // One-time dunning warning email (best-effort; reset to null on recovery so a
  // future failure warns again).
  try {
    const { data: warned } = await supabaseAdmin
      .from("subscriptions")
      .select("dunning_warned_at")
      .eq("user_id", userId)
      .maybeSingle();
    if (!warned?.dunning_warned_at) {
      const contact = await getProfileBillingContact(userId);
      if (await sendEmail(contact.email, "חיוב המנוי נכשל — נדרשת פעולה", dunningHtml(contact.fullName))) {
        await supabaseAdmin
          .from("subscriptions")
          .update({ dunning_warned_at: iso(now) })
          .eq("user_id", userId);
      }
    }
  } catch (e) {
    logger.warn({ err: String(e), userId }, "dunning_email_failed");
  }
}

/**
 * Downgrade to free when the access window elapsed: either dunning grace ran
 * out (past_due) or a user-requested cancellation reached period end.
 */
export async function expireOverdueSubscriptions(): Promise<number> {
  const nowIso = iso(new Date());
  const downgrade = {
    plan: "free",
    status: "active",
    expires_at: null,
    next_billing_at: null,
    trial_ends_at: null,
    auto_renew: false,
    cancel_at_period_end: false,
    // Drop any scheduled downgrade so it can't resurface after a re-subscribe.
    pending_plan: null,
    dunning_status: "downgraded",
    updated_at: nowIso,
  };

  const pastDue = await supabaseAdmin
    .from("subscriptions")
    .update(downgrade)
    .eq("status", "past_due")
    .lt("expires_at", nowIso)
    .select("user_id");
  if (pastDue.error) throw new Error(`expireOverdue(past_due): ${pastDue.error.message}`);

  const canceled = await supabaseAdmin
    .from("subscriptions")
    .update(downgrade)
    .eq("cancel_at_period_end", true)
    .neq("plan", "free")
    .lt("expires_at", nowIso)
    .select("user_id");
  if (canceled.error) throw new Error(`expireOverdue(canceled): ${canceled.error.message}`);

  return (pastDue.data?.length ?? 0) + (canceled.data?.length ?? 0);
}

export async function setCancelAtPeriodEnd(userId: string, cancel: boolean): Promise<void> {
  const { error } = await supabaseAdmin
    .from("subscriptions")
    .update({ cancel_at_period_end: cancel, updated_at: iso(new Date()) })
    .eq("user_id", userId);
  if (error) throw new Error(`setCancelAtPeriodEnd: ${error.message}`);
}

/**
 * Card was replaced (update-card flow) — re-arm renewals. Resets the failure
 * counter and dunning state, and clears the claim stamp so the next renewal pass
 * can immediately retry the now-valid card. Without this a customer who updates
 * their card after 3 failed charges stays excluded from claim_due_subscriptions
 * (failed_charge_count >= 3) and is downgraded despite a working card.
 */
export async function clearDunningOnCardUpdate(userId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("subscriptions")
    .update({
      failed_charge_count: 0,
      dunning_status: null,
      dunning_warned_at: null,
      last_charge_attempt_at: null,
      updated_at: iso(new Date()),
    })
    .eq("user_id", userId);
  if (error) throw new Error(`clearDunningOnCardUpdate: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Payments ledger (idempotent) + consent + invoices
// ---------------------------------------------------------------------------

export interface RecordPaymentInput {
  userId: string;
  plan: string;
  amount?: number | null;
  providerTxnId?: string | null;
  /** Grow transaction token — needed later to issue a refund for this charge. */
  providerTxnToken?: string | null;
  asmachta?: string | null;
  transactionUniqueId?: number | string | null;
  transactionGroupId?: number | string | null;
  cardSuffix?: string | null;
  cardBrand?: string | null;
  kind: "subscribe" | "trial" | "renewal" | "refund" | "upgrade" | "storage_addon" | "comp";
  status: "success" | "failed" | "rejected_amount" | "pending";
  errorText?: string | null;
}

/** Insert a payment row. Returns deduped=true if the unique key already exists. */
export async function recordPayment(i: RecordPaymentInput): Promise<{ deduped: boolean }> {
  const { error } = await supabaseAdmin.from("subscription_payments").insert({
    user_id: i.userId,
    plan: i.plan,
    amount: i.amount ?? null,
    provider: "grow",
    provider_txn_id: i.providerTxnId ?? null,
    provider_txn_token: i.providerTxnToken ?? null,
    asmachta: i.asmachta ?? null,
    transaction_unique_id: i.transactionUniqueId ?? null,
    transaction_group_id: i.transactionGroupId ?? null,
    card_suffix: i.cardSuffix ?? null,
    card_brand: i.cardBrand ?? null,
    kind: i.kind,
    status: i.status,
    error_text: i.errorText ?? null,
  });
  if (error) {
    if (error.code === "23505") return { deduped: true }; // unique_violation
    throw new Error(`recordPayment: ${error.message}`);
  }
  return { deduped: false };
}

/**
 * Count the user's successful PAID charges so far (excludes the ₪0 trial and
 * refunds). Used to determine the promo-vs-regular price of the next charge.
 */
export async function countPaidCharges(userId: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from("subscription_payments")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("status", "success")
    .in("kind", ["subscribe", "renewal"])
    .gt("amount", 0); // exclude ₪0 tester grants / trials
  if (error) {
    logger.error({ err: error.message, userId }, "count_paid_charges_failed");
    return 0;
  }
  return count ?? 0;
}

/**
 * The 1-based billing cycle of the NEXT charge for this user: one more than the
 * number of successful paid charges already made. Cycle 1 is the first paid
 * charge (promo). Pass to priceFor()/amountMatches().
 */
export async function nextChargeCycle(userId: string): Promise<number> {
  return (await countPaidCharges(userId)) + 1;
}

/** Finalize a previously-recorded pending payment (renewal) to success/failed. */
export async function finalizePayment(
  transactionUniqueId: number | string,
  fields: {
    status: "success" | "failed";
    providerTxnId?: string | null;
    asmachta?: string | null;
    cardSuffix?: string | null;
    cardBrand?: string | null;
    errorText?: string | null;
  },
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("subscription_payments")
    .update({
      status: fields.status,
      provider_txn_id: fields.providerTxnId ?? null,
      asmachta: fields.asmachta ?? null,
      card_suffix: fields.cardSuffix ?? null,
      card_brand: fields.cardBrand ?? null,
      error_text: fields.errorText ?? null,
    })
    .eq("transaction_unique_id", transactionUniqueId);
  if (error) throw new Error(`finalizePayment: ${error.message}`);
}

/** True if we've already processed a transaction with this provider txn id. */
export async function isTxnProcessed(providerTxnId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("subscription_payments")
    .select("id")
    .eq("provider_txn_id", providerTxnId)
    .limit(1);
  if (error) throw new Error(`isTxnProcessed: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

export async function attachInvoice(
  providerTxnId: string | undefined,
  asmachta: string | undefined,
  ref: string | undefined,
  url: string | undefined,
): Promise<void> {
  if (!ref && !url) return;
  const fields = { invoice_ref: ref ?? null, invoice_url: url ?? null };
  // Primary match: provider_txn_id (the dedupe / finalize id we stored).
  if (providerTxnId) {
    const { data } = await supabaseAdmin
      .from("subscription_payments")
      .update(fields)
      .eq("provider_txn_id", providerTxnId)
      .select("id");
    if (data && data.length) return;
  }
  // Fallback: some invoice notifies key off the asmachta rather than the txn id
  // (or the row stored asmachta as its provider_txn_id). Don't silently drop it.
  if (asmachta) {
    const { data } = await supabaseAdmin
      .from("subscription_payments")
      .update(fields)
      .eq("asmachta", asmachta)
      .select("id");
    if (data && data.length) return;
  }
  logger.warn({ providerTxnId, asmachta }, "invoice_notify_unmatched");
}

// ---------------------------------------------------------------------------
// Refunds (14-day cooling-off)
// ---------------------------------------------------------------------------

export interface RefundableCharge {
  providerTxnId: string;
  providerTxnToken: string;
  amount: number;
  plan: string;
  createdAt: string;
}

/**
 * The user's most recent successful paid charge (subscribe/renewal, amount>0)
 * that still has a Grow token to refund against and has NOT already been
 * refunded. The 14-day eligibility window is enforced by the caller. Returns
 * null when there's nothing refundable (no token = a charge from before refund
 * support shipped → must be refunded manually in the Grow dashboard).
 */
export async function getRefundableCharge(userId: string): Promise<RefundableCharge | null> {
  const { data, error } = await supabaseAdmin
    .from("subscription_payments")
    .select("provider_txn_id, provider_txn_token, amount, plan, created_at")
    .eq("user_id", userId)
    .eq("status", "success")
    .in("kind", ["subscribe", "renewal"])
    .gt("amount", 0)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`getRefundableCharge: ${error.message}`);
  if (!data?.provider_txn_id || !data?.provider_txn_token) return null;

  // Already refunded? (refund rows are stored as `refund:<original txn id>`.)
  const { data: existing } = await supabaseAdmin
    .from("subscription_payments")
    .select("id")
    .eq("user_id", userId)
    .eq("kind", "refund")
    .eq("provider_txn_id", `refund:${data.provider_txn_id}`)
    .limit(1);
  if (existing && existing.length) return null;

  return {
    providerTxnId: String(data.provider_txn_id),
    providerTxnToken: String(data.provider_txn_token),
    amount: Number(data.amount),
    plan: String(data.plan),
    createdAt: String(data.created_at),
  };
}

/** Record a refund in the ledger (id prefixed to avoid the provider_txn_id unique index). */
export async function recordRefund(i: {
  userId: string;
  plan: string;
  amount: number;
  refundedTxnId: string;
}): Promise<void> {
  const { error } = await supabaseAdmin.from("subscription_payments").insert({
    user_id: i.userId,
    plan: i.plan,
    amount: i.amount,
    provider: "grow",
    provider_txn_id: `refund:${i.refundedTxnId}`,
    kind: "refund",
    status: "success",
  });
  if (error) throw new Error(`recordRefund: ${error.message}`);
}

/** Grant purchased storage after a verified charge (service-role RPC). */
export async function grantStoragePurchase(userId: string, gb: number): Promise<void> {
  const { error } = await supabaseAdmin.rpc("grant_storage_purchase", {
    p_user_id: userId,
    p_gb: gb,
  });
  if (error) throw new Error(`grantStoragePurchase: ${error.message}`);
}

/**
 * Admin comp: grant one free month. Extends the billing anchor by a month with
 * NO charge, restores service (clears dunning / sets active), and records a ₪0
 * 'comp' ledger row. amount:0 keeps it out of revenue & the promo-cycle count.
 */
export async function compFreeMonth(userId: string): Promise<{ ok: boolean; error?: string }> {
  const { data: sub } = await supabaseAdmin
    .from("subscriptions")
    .select("plan, next_billing_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (!sub || !isPaidPlan(sub.plan as string)) return { ok: false, error: "not_paid" };

  const now = new Date();
  const base = sub.next_billing_at ? new Date(sub.next_billing_at as string) : now;
  const anchor = base.getTime() > now.getTime() ? base : now;
  const nextBilling = addMonths(anchor, 1);
  const { error } = await supabaseAdmin
    .from("subscriptions")
    .update({
      status: "active",
      next_billing_at: iso(nextBilling),
      expires_at: iso(addDays(nextBilling, GRACE_DAYS)),
      failed_charge_count: 0,
      dunning_status: null,
      dunning_warned_at: null,
      updated_at: iso(now),
    })
    .eq("user_id", userId);
  if (error) throw new Error(`compFreeMonth: ${error.message}`);

  await recordPayment({
    userId,
    plan: sub.plan as string,
    amount: 0,
    kind: "comp",
    status: "success",
    providerTxnId: `comp:${randomUUID()}`,
  });
  return { ok: true };
}

/** Token-free payment-method summary for the admin UI (NEVER returns the token). */
export async function getPaymentMethodSummary(userId: string): Promise<{
  cardSuffix: string | null;
  cardBrand: string | null;
  isValid: boolean;
  chargeCount: number;
} | null> {
  const { data } = await supabaseAdmin
    .from("payment_methods")
    .select("card_suffix, card_brand, is_valid, charge_count")
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return null;
  return {
    cardSuffix: data.card_suffix ?? null,
    cardBrand: data.card_brand ?? null,
    isValid: data.is_valid ?? false,
    chargeCount: data.charge_count ?? 0,
  };
}

/** Immediate downgrade to free after a cooling-off refund (access ends now). */
export async function downgradeToFreeImmediate(userId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("subscriptions")
    .update({
      plan: "free",
      status: "active",
      expires_at: null,
      next_billing_at: null,
      trial_ends_at: null,
      auto_renew: false,
      cancel_at_period_end: false,
      pending_plan: null,
      dunning_status: "refunded",
      updated_at: iso(new Date()),
    })
    .eq("user_id", userId);
  if (error) throw new Error(`downgradeToFreeImmediate: ${error.message}`);
}

/**
 * Admin manual downgrade to free — clean (no dunning taint, unlike the
 * refund-driven downgradeToFreeImmediate). Clears all billing state.
 */
export async function downgradeToFreeAdmin(userId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("subscriptions")
    .update({
      plan: "free",
      status: "active",
      expires_at: null,
      next_billing_at: null,
      trial_ends_at: null,
      auto_renew: false,
      cancel_at_period_end: false,
      pending_plan: null,
      dunning_status: null,
      updated_at: iso(new Date()),
    })
    .eq("user_id", userId);
  if (error) throw new Error(`downgradeToFreeAdmin: ${error.message}`);
}

/**
 * Admin manual grant of a paid plan with NO charge — turns any user (free, etc.)
 * into an active subscriber. Leaves no billing anchor (next_billing_at stays as
 * is / null), so it's a comp-style grant, not a recurring paid subscription, and
 * it won't be counted in "paying subscribers"/MRR (which require a real charge).
 */
export async function grantPaidPlanAdmin(userId: string, plan: PaidPlan): Promise<void> {
  const { error } = await supabaseAdmin
    .from("subscriptions")
    .update({
      plan,
      status: "active",
      cancel_at_period_end: false,
      pending_plan: null,
      dunning_status: null,
      updated_at: iso(new Date()),
    })
    .eq("user_id", userId);
  if (error) throw new Error(`grantPaidPlanAdmin: ${error.message}`);
}

export async function recordConsent(i: {
  userId: string;
  plan: string;
  consentTextVersion: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  const { error } = await supabaseAdmin.from("billing_consent").insert({
    user_id: i.userId,
    plan: i.plan,
    consent_text_version: i.consentTextVersion,
    ip: i.ip ?? null,
    user_agent: i.userAgent ?? null,
  });
  if (error) throw new Error(`recordConsent: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Renewal scheduling primitives (clean RPCs; concurrency-safe)
// ---------------------------------------------------------------------------

export interface DueSubscription {
  userId: string;
  plan: PaidPlan;
  /** Scheduled downgrade target to apply on this renewal, if any. */
  pendingPlan: PaidPlan | null;
  cardSuffix: string | null;
  billingGroupId: number;
}

/**
 * Claim due subscriptions. The RPC does SELECT ... FOR UPDATE SKIP LOCKED,
 * stamps last_charge_attempt_at (claim window), and only returns rows that
 * have a valid card — so an invalid card naturally drops out of retries.
 */
export async function claimDueSubscriptions(limit: number): Promise<DueSubscription[]> {
  const { data, error } = await supabaseAdmin.rpc("claim_due_subscriptions", { p_limit: limit });
  if (error) throw new Error(`claimDueSubscriptions: ${error.message}`);
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    userId: String(r.user_id),
    plan: r.plan as PaidPlan,
    pendingPlan: (r.pending_plan as PaidPlan | null) ?? null,
    cardSuffix: (r.card_suffix as string | null) ?? null,
    billingGroupId: Number(r.billing_group_id),
  }));
}

/** Allocate a fresh numeric transactionUniqueIdentifier (per charge attempt). */
export async function nextUniqueId(): Promise<number> {
  const { data, error } = await supabaseAdmin.rpc("next_billing_unique_id");
  if (error) throw new Error(`nextUniqueId: ${error.message}`);
  return Number(data);
}

export async function getProfileBillingContact(userId: string): Promise<{
  fullName: string;
  phone: string;
  email: string | null;
  businessName: string | null;
  businessId: string | null;
}> {
  const { data } = await supabaseAdmin
    .from("profiles")
    .select("full_name, phone, email, business_name, business_id")
    .eq("user_id", userId)
    .maybeSingle();
  return {
    fullName: data?.full_name || data?.business_name || "לקוח",
    phone: data?.phone || "",
    email: data?.email ?? null,
    businessName: data?.business_name ?? null,
    businessId: data?.business_id ?? null,
  };
}
