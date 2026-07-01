/** Backend subscription tiers (NOT the marketing labels on the pricing page). */
export type PaidPlan = "premium" | "pro";

export interface PlanPricing {
  /** Promo price (shekels, VAT-included) for the first PROMO_CHARGES paid cycles. */
  promo: number;
  /** Regular price from the (PROMO_CHARGES + 1)th charge onward. */
  regular: number;
}

/**
 * Monthly price per tier, in shekels, VAT-INCLUDED. These are the final amounts
 * charged and displayed to the customer; no VAT is added on top anywhere in the
 * billing path. The Grow account must be configured to issue VAT-inclusive
 * invoices for these sums (no extra 18% added).
 */
export const PLAN_PRICING: Record<PaidPlan, PlanPricing> = {
  premium: { promo: 49, regular: 149 },
  pro: { promo: 99, regular: 249 },
};

/** The first N successful paid charges are billed at the promo price. */
export const PROMO_CHARGES = 3;

export const PLAN_LABELS: Record<PaidPlan, string> = {
  premium: "Premium",
  pro: "Pro",
};

/** One-time storage add-on packages: GB → price (₪, VAT-inclusive). Must match
 *  the prices shown in the client StorageUpgradeDialog. */
export const STORAGE_PACKAGES: Record<number, number> = {
  5: 19,
  20: 49,
  50: 99,
};

export const TRIAL_DAYS = 14;
/** Dunning grace window after a failed renewal before downgrade to free. */
export const GRACE_DAYS = 3;
/** Grow's hard limit of charges per saved token. */
export const MAX_TOKEN_CHARGES = 180;
/** Max renewal attempts before giving up and expiring. */
export const MAX_RENEWAL_RETRIES = 3;

export function isPaidPlan(p: string | null | undefined): p is PaidPlan {
  return p === "premium" || p === "pro";
}

/**
 * Price for a given billing cycle (1-based). Cycles 1..PROMO_CHARGES are billed
 * at the promo price; from PROMO_CHARGES+1 onward at the regular price.
 * Defaults to cycle 1 (promo) — correct for the very first charge.
 */
export function priceFor(plan: PaidPlan, cycleNumber = 1): number {
  const p = PLAN_PRICING[plan];
  return cycleNumber <= PROMO_CHARGES ? p.promo : p.regular;
}

/** Coupon terms as frozen on a coupon_redemptions row (see coupons.ts). */
export interface DiscountSnapshot {
  discountType: "percent" | "fixed";
  discountValue: number;
}

/** Floor for any discounted charge — Grow rejects sum<=0 (the trial flow's
 *  ₪1 token-save placeholder, below, exists to work around the same limit). */
export const MIN_CHARGE_AMOUNT = 5;

/**
 * Apply a coupon (if any) to a base price. Never returns more than `base`
 * (a coupon can only reduce a price) and never less than MIN_CHARGE_AMOUNT
 * (a 100%-off or oversized fixed coupon clamps to the floor, not to 0/negative).
 */
export function applyDiscount(base: number, discount?: DiscountSnapshot | null): number {
  if (!discount) return base;
  const raw =
    discount.discountType === "percent"
      ? base * (1 - discount.discountValue / 100)
      : base - discount.discountValue;
  return round2(Math.max(MIN_CHARGE_AMOUNT, Math.min(raw, base)));
}

/** priceFor() with an optional coupon applied — the single source of truth for
 *  "what should this charge actually be", used by checkout, renewals, and the
 *  trial-reminder email alike. */
export function expectedChargeFor(
  plan: PaidPlan,
  cycleNumber: number,
  discount?: DiscountSnapshot | null,
): number {
  return applyDiscount(priceFor(plan, cycleNumber), discount);
}

/**
 * Anti-tampering check: the charged amount must be at least the expected price
 * for the given cycle (small tolerance for rounding). Defends against a
 * spoofed/low webhook amount. `discount`, when passed, MUST come from
 * server-side state (a confirmed coupon_redemptions row) — never from anything
 * the client or the webhook payload claims — otherwise this check stops
 * defending against anything.
 */
export function amountMatches(
  plan: PaidPlan,
  sum: number | null | undefined,
  cycleNumber = 1,
  discount?: DiscountSnapshot | null,
): boolean {
  if (sum == null || Number.isNaN(sum)) return false;
  const expected = expectedChargeFor(plan, cycleNumber, discount);
  // Both bounds are anchored to the price expected for THIS cycle (promo in the
  // promo window, regular afterwards, discounted if a coupon applies), with
  // ₪0.5 rounding tolerance. Lower bound: anti-tampering (no spoofed
  // undercharge). Upper bound: catch a silent overcharge — including the
  // full/VAT-inflated price wrongly applied DURING the promo window (a
  // cycle-independent ceiling would have let ₪149 pass at cycle 1).
  return sum >= expected - 0.5 && sum <= expected + 0.5;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Prorated charge for an immediate mid-cycle upgrade: the price difference
 * between the new and old plan for the CURRENT cycle, scaled by the unused
 * fraction of the current paid period. Uses priceFor() so it stays in lockstep
 * with renewals (and with the VAT-inclusive prices). Returns a non-negative,
 * 2-decimal shekel amount; 0 when there is nothing left to prorate.
 */
export function prorationDelta(
  fromPlan: PaidPlan,
  toPlan: PaidPlan,
  cycleNumber: number,
  daysRemaining: number,
  daysInPeriod: number,
): number {
  if (daysInPeriod <= 0) return 0;
  const fullDelta = priceFor(toPlan, cycleNumber) - priceFor(fromPlan, cycleNumber);
  if (fullDelta <= 0) return 0;
  const ratio = clamp(daysRemaining / daysInPeriod, 0, 1);
  return round2(fullDelta * ratio);
}
