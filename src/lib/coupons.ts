import { supabaseAdmin } from "./supabaseAdmin.js";
import { expectedChargeFor, type DiscountSnapshot, type PaidPlan } from "./plans.js";
import { logger } from "./logger.js";

export type DiscountType = "percent" | "fixed";
export type DurationType = "once" | "repeating" | "forever";

export type CouponErrorCode =
  | "coupon_not_found"
  | "coupon_inactive"
  | "coupon_not_started"
  | "coupon_expired"
  | "coupon_exhausted"
  | "coupon_already_used"
  | "plan_not_eligible"
  | "coupon_invalid";

const KNOWN_ERROR_CODES = new Set<string>([
  "coupon_not_found",
  "coupon_inactive",
  "coupon_not_started",
  "coupon_expired",
  "coupon_exhausted",
  "coupon_already_used",
  "plan_not_eligible",
]);

function toErrorCode(message: string | undefined): CouponErrorCode {
  const code = (message ?? "").trim();
  return KNOWN_ERROR_CODES.has(code) ? (code as CouponErrorCode) : "coupon_invalid";
}

// ---------------------------------------------------------------------------
// Checkout-time redemption (reservation -> confirm -> apply-per-cycle)
// ---------------------------------------------------------------------------

export interface RedeemedCoupon {
  redemptionId: string;
  discount: DiscountSnapshot;
  durationType: DurationType;
  durationCycles: number | null;
}

export type RedeemResult = { ok: true; coupon: RedeemedCoupon } | { ok: false; error: CouponErrorCode };

/**
 * Reserve a coupon for this checkout attempt (via redeem_coupon_atomic, which
 * locks the coupon row so concurrent redeemers of the same code serialize —
 * see the migration for the full concurrency argument). MUST be called before
 * the Grow charge is created, since the discounted sum is what gets sent to
 * Grow. Retrying with the same code while the previous attempt is still
 * 'pending' reuses that reservation instead of creating a duplicate.
 */
export async function redeemCoupon(
  code: string,
  userId: string,
  plan: PaidPlan,
  cycle: number,
): Promise<RedeemResult> {
  const { data, error } = await supabaseAdmin.rpc("redeem_coupon_atomic", {
    p_code: code.trim(),
    p_user_id: userId,
    p_plan: plan,
    p_cycle: cycle,
  });
  if (error) return { ok: false, error: toErrorCode(error.message) };
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  if (!row) return { ok: false, error: "coupon_invalid" };
  return {
    ok: true,
    coupon: {
      redemptionId: String(row.redemption_id),
      discount: {
        discountType: row.discount_type as DiscountType,
        discountValue: Number(row.discount_value),
      },
      durationType: row.duration_type as DurationType,
      durationCycles: (row.duration_cycles as number | null) ?? null,
    },
  };
}

/**
 * Flip a reservation from pending -> active once the subscription action it
 * was reserved for actually succeeded (trial started / first charge
 * confirmed). Scoped by user_id so a spoofed/mismatched redemption reference
 * degrades to "no discount found" (null) rather than granting someone else's
 * coupon — the caller's price check then falls back to full price, never a
 * lower one. Accepts a previously-'abandoned' row too (not just 'pending') so
 * a slow-but-legitimate payer whose reservation got reaped mid-payment can
 * still confirm instead of being charged without activation.
 */
export async function confirmRedemption(
  redemptionId: string,
  userId: string,
): Promise<DiscountSnapshot | null> {
  const { data, error } = await supabaseAdmin
    .from("coupon_redemptions")
    .update({ status: "active", updated_at: new Date().toISOString() })
    .eq("id", redemptionId)
    .eq("user_id", userId)
    .in("status", ["pending", "abandoned"])
    .select("discount_type_snapshot, discount_value_snapshot")
    .maybeSingle();
  if (error) {
    logger.error({ err: error.message, redemptionId }, "coupon_confirm_failed");
    return null;
  }
  if (!data) return null;
  return {
    discountType: data.discount_type_snapshot as DiscountType,
    discountValue: Number(data.discount_value_snapshot),
  };
}

/**
 * The discount currently in effect for a subscription's linked redemption, if
 * any — used by checkout/renew/notifications to price a charge. Re-checks the
 * cycle budget independently of subscriptions.coupon_redemption_id having
 * been cleared (defense-in-depth: a stale FK can only under-discount, never
 * over-discount, since this returns null rather than trusting the FK alone).
 */
export async function getActiveDiscount(
  redemptionId: string | null | undefined,
): Promise<DiscountSnapshot | null> {
  if (!redemptionId) return null;
  const { data, error } = await supabaseAdmin
    .from("coupon_redemptions")
    .select(
      "status, discount_type_snapshot, discount_value_snapshot, duration_type_snapshot, duration_cycles_snapshot, cycles_applied",
    )
    .eq("id", redemptionId)
    .maybeSingle();
  if (error || !data || data.status !== "active") return null;
  if (data.duration_type_snapshot === "once" && (data.cycles_applied as number) >= 1) return null;
  if (
    data.duration_type_snapshot === "repeating" &&
    data.duration_cycles_snapshot != null &&
    (data.cycles_applied as number) >= (data.duration_cycles_snapshot as number)
  ) {
    return null;
  }
  return {
    discountType: data.discount_type_snapshot as DiscountType,
    discountValue: Number(data.discount_value_snapshot),
  };
}

/**
 * Record that a discounted cycle was actually charged. Call exactly once per
 * CONFIRMED successful charge (mirrors the increment_charge_count invariant)
 * from webhooks.ts (subscribe), renew.ts (renewal + trial-conversion), and
 * reconcile.ts (delayed confirmation). Flips the redemption to 'exhausted' and
 * clears subscriptions.coupon_redemption_id once the coupon's duration budget
 * is used up (never for 'forever').
 */
export async function applyCouponCycle(redemptionId: string): Promise<void> {
  const { error } = await supabaseAdmin.rpc("apply_coupon_cycle", { p_redemption_id: redemptionId });
  if (error) logger.error({ err: error.message, redemptionId }, "apply_coupon_cycle_failed");
}

// ---------------------------------------------------------------------------
// Live checkout-dialog preview (read-only, no reservation)
// ---------------------------------------------------------------------------

export interface CouponPreview {
  discountType: DiscountType;
  discountValue: number;
  /** The real amount this user would be charged right now, incl. their actual
   *  promo-vs-regular cycle — computed the same way checkout.ts prices the
   *  real charge, so the frontend can show it verbatim. */
  discountedPrice: number;
}

export type PreviewResult = { ok: true; preview: CouponPreview } | { ok: false; error: CouponErrorCode };

/**
 * Read-only validation for the checkout dialog's live "apply code" check.
 * Deliberately does NOT reserve a redemption — that only happens in
 * redeemCoupon(), at the real /api/checkout submit — so a user trying a few
 * codes before picking one doesn't burn max_redemptions slots on codes they
 * never actually use. This duplicates redeem_coupon_atomic's validity
 * predicate (minus locking/writes); keep the two in sync if either changes.
 * Can go stale between preview and the real submit (code expires/exhausts in
 * between) — expected, redeemCoupon() re-validates authoritatively either way.
 */
export async function previewCoupon(
  code: string,
  userId: string,
  plan: PaidPlan,
  cycle: number,
): Promise<PreviewResult> {
  const { data: coupon, error } = await supabaseAdmin
    .from("coupon_codes")
    .select("*")
    .eq("code", code.trim().toUpperCase())
    .maybeSingle();
  if (error) {
    logger.error({ err: error.message, code }, "coupon_preview_query_failed");
    return { ok: false, error: "coupon_invalid" };
  }
  if (!coupon) return { ok: false, error: "coupon_not_found" };
  if (!coupon.is_active) return { ok: false, error: "coupon_inactive" };

  const now = Date.now();
  if (coupon.starts_at && new Date(coupon.starts_at as string).getTime() > now) {
    return { ok: false, error: "coupon_not_started" };
  }
  if (coupon.expires_at && new Date(coupon.expires_at as string).getTime() <= now) {
    return { ok: false, error: "coupon_expired" };
  }
  const applicablePlans = coupon.applicable_plans as PaidPlan[] | null;
  if (applicablePlans && !applicablePlans.includes(plan)) {
    return { ok: false, error: "plan_not_eligible" };
  }
  const maxRedemptions = coupon.max_redemptions as number | null;
  if (maxRedemptions != null && (coupon.redemption_count as number) >= maxRedemptions) {
    return { ok: false, error: "coupon_exhausted" };
  }

  const { count } = await supabaseAdmin
    .from("coupon_redemptions")
    .select("id", { count: "exact", head: true })
    .eq("coupon_id", coupon.id as string)
    .eq("user_id", userId)
    .neq("status", "abandoned");
  if ((count ?? 0) >= (coupon.per_user_limit as number)) {
    return { ok: false, error: "coupon_already_used" };
  }

  const discount: DiscountSnapshot = {
    discountType: coupon.discount_type as DiscountType,
    discountValue: Number(coupon.discount_value),
  };
  return {
    ok: true,
    preview: {
      discountType: discount.discountType,
      discountValue: discount.discountValue,
      discountedPrice: expectedChargeFor(plan, cycle, discount),
    },
  };
}

// ---------------------------------------------------------------------------
// Admin CRUD
// ---------------------------------------------------------------------------

export interface CouponRow {
  id: string;
  code: string;
  description: string | null;
  discountType: DiscountType;
  discountValue: number;
  applicablePlans: PaidPlan[] | null;
  durationType: DurationType;
  durationCycles: number | null;
  maxRedemptions: number | null;
  redemptionCount: number;
  perUserLimit: number;
  active: boolean;
  startsAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface CouponInput {
  code: string;
  description?: string | null;
  discountType: DiscountType;
  discountValue: number;
  applicablePlans?: PaidPlan[] | null;
  durationType: DurationType;
  durationCycles?: number | null;
  maxRedemptions?: number | null;
  perUserLimit?: number;
  active?: boolean;
  startsAt?: string | null;
  expiresAt?: string | null;
}

function mapCouponRow(r: Record<string, unknown>): CouponRow {
  return {
    id: String(r.id),
    code: String(r.code),
    description: (r.description as string | null) ?? null,
    discountType: r.discount_type as DiscountType,
    discountValue: Number(r.discount_value),
    applicablePlans: (r.applicable_plans as PaidPlan[] | null) ?? null,
    durationType: r.duration_type as DurationType,
    durationCycles: (r.duration_cycles as number | null) ?? null,
    maxRedemptions: (r.max_redemptions as number | null) ?? null,
    redemptionCount: Number(r.redemption_count ?? 0),
    perUserLimit: Number(r.per_user_limit ?? 1),
    active: !!r.is_active,
    startsAt: (r.starts_at as string | null) ?? null,
    expiresAt: (r.expires_at as string | null) ?? null,
    createdAt: String(r.created_at),
  };
}

export async function listCoupons(): Promise<CouponRow[]> {
  const { data, error } = await supabaseAdmin
    .from("coupon_codes")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listCoupons: ${error.message}`);
  return (data ?? []).map(mapCouponRow);
}

export async function createCoupon(input: CouponInput, createdBy: string): Promise<CouponRow> {
  const { data, error } = await supabaseAdmin
    .from("coupon_codes")
    .insert({
      code: input.code.trim().toUpperCase(),
      description: input.description ?? null,
      discount_type: input.discountType,
      discount_value: input.discountValue,
      applicable_plans: input.applicablePlans ?? null,
      duration_type: input.durationType,
      duration_cycles: input.durationType === "repeating" ? input.durationCycles ?? null : null,
      max_redemptions: input.maxRedemptions ?? null,
      per_user_limit: input.perUserLimit ?? 1,
      is_active: input.active ?? true,
      starts_at: input.startsAt ?? null,
      expires_at: input.expiresAt ?? null,
      created_by: createdBy,
    })
    .select("*")
    .single();
  if (error) throw new Error(`createCoupon: ${error.message}`);
  return mapCouponRow(data);
}

export async function updateCoupon(id: string, patch: Partial<CouponInput>): Promise<CouponRow> {
  const fields: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.code !== undefined) fields.code = patch.code.trim().toUpperCase();
  if (patch.description !== undefined) fields.description = patch.description;
  if (patch.discountType !== undefined) fields.discount_type = patch.discountType;
  if (patch.discountValue !== undefined) fields.discount_value = patch.discountValue;
  if (patch.applicablePlans !== undefined) fields.applicable_plans = patch.applicablePlans;
  if (patch.durationType !== undefined) fields.duration_type = patch.durationType;
  if (patch.durationCycles !== undefined) fields.duration_cycles = patch.durationCycles;
  if (patch.maxRedemptions !== undefined) fields.max_redemptions = patch.maxRedemptions;
  if (patch.perUserLimit !== undefined) fields.per_user_limit = patch.perUserLimit;
  if (patch.active !== undefined) fields.is_active = patch.active;
  if (patch.startsAt !== undefined) fields.starts_at = patch.startsAt;
  if (patch.expiresAt !== undefined) fields.expires_at = patch.expiresAt;

  const { data, error } = await supabaseAdmin
    .from("coupon_codes")
    .update(fields)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw new Error(`updateCoupon: ${error.message}`);
  return mapCouponRow(data);
}

export async function setCouponActive(id: string, active: boolean): Promise<CouponRow> {
  return updateCoupon(id, { active });
}
