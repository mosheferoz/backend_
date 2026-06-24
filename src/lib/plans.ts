/** Backend subscription tiers (NOT the marketing labels on the pricing page). */
export type PaidPlan = "premium" | "pro";

export interface PlanPricing {
  /** Promo price (shekels, excl. VAT) for the first PROMO_CHARGES paid cycles. */
  promo: number;
  /** Regular price from the (PROMO_CHARGES + 1)th charge onward. */
  regular: number;
}

/** Monthly price per tier, in shekels (excl. VAT). */
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

/**
 * Anti-tampering check: the charged amount must be at least the expected price
 * for the given cycle (small tolerance for rounding). Defends against a
 * spoofed/low webhook amount.
 */
export function amountMatches(
  plan: PaidPlan,
  sum: number | null | undefined,
  cycleNumber = 1,
): boolean {
  if (sum == null || Number.isNaN(sum)) return false;
  return sum >= priceFor(plan, cycleNumber) - 0.5;
}
