import { supabaseAdmin } from "./supabaseAdmin.js";
import { encryptToken, decryptToken } from "./crypto.js";
import { GRACE_DAYS, TRIAL_DAYS, type PaidPlan } from "./plans.js";
import { logger } from "./logger.js";

// --- date helpers (calendar-correct month/day math) ---
function addMonths(d: Date, n: number): Date {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
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
      failed_charge_count: 0,
      dunning_status: null,
      last_payment_at: iso(now),
      last_payment_amount: i.sum,
      card_suffix: i.cardSuffix ?? null,
      card_brand: i.cardBrand ?? null,
      last_charge_attempt_at: iso(now),
      updated_at: iso(now),
    })
    .eq("user_id", i.userId);
  if (error) throw new Error(`activatePaidSubscription: ${error.message}`);
}

/** TEMP: grant access to a tester without payment (no card, no auto-renew). */
export async function grantTesterAccess(userId: string, plan: PaidPlan, days = 365): Promise<void> {
  const now = new Date();
  const { error } = await supabaseAdmin
    .from("subscriptions")
    .update({
      plan,
      status: "active",
      purchased_at: iso(now),
      expires_at: iso(addDays(now, days)),
      next_billing_at: null,
      auto_renew: false,
      cancel_at_period_end: false,
      failed_charge_count: 0,
      dunning_status: "tester",
      updated_at: iso(now),
    })
    .eq("user_id", userId);
  if (error) throw new Error(`grantTesterAccess: ${error.message}`);
}

/** Renewal success — extend the period; clear dunning state. */
export async function renewSubscription(userId: string, sum: number): Promise<void> {
  const now = new Date();
  const nextBilling = addMonths(now, 1);
  const { error } = await supabaseAdmin
    .from("subscriptions")
    .update({
      status: "active",
      next_billing_at: iso(nextBilling),
      expires_at: iso(addDays(nextBilling, GRACE_DAYS)),
      failed_charge_count: 0,
      dunning_status: null,
      last_payment_at: iso(now),
      last_payment_amount: sum,
      last_charge_attempt_at: iso(now),
      updated_at: iso(now),
    })
    .eq("user_id", userId);
  if (error) throw new Error(`renewSubscription: ${error.message}`);
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

// ---------------------------------------------------------------------------
// Payments ledger (idempotent) + consent + invoices
// ---------------------------------------------------------------------------

export interface RecordPaymentInput {
  userId: string;
  plan: string;
  amount?: number | null;
  providerTxnId?: string | null;
  asmachta?: string | null;
  transactionUniqueId?: number | string | null;
  transactionGroupId?: number | string | null;
  cardSuffix?: string | null;
  cardBrand?: string | null;
  kind: "subscribe" | "trial" | "renewal" | "refund";
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
  providerTxnId: string,
  ref: string | undefined,
  url: string | undefined,
): Promise<void> {
  if (!ref && !url) return;
  await supabaseAdmin
    .from("subscription_payments")
    .update({ invoice_ref: ref ?? null, invoice_url: url ?? null })
    .eq("provider_txn_id", providerTxnId);
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
