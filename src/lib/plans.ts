/** Backend subscription tiers (NOT the marketing labels on the pricing page). */
export type PaidPlan = "premium" | "pro";

/** Monthly price per tier, in shekels. */
export const PLAN_PRICES: Record<PaidPlan, number> = {
  premium: 49,
  pro: 249,
};

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

export function priceFor(plan: PaidPlan): number {
  return PLAN_PRICES[plan];
}

/**
 * Anti-tampering check: the charged amount must be at least the expected price
 * (small tolerance for rounding). Defends against a spoofed/low webhook amount.
 */
export function amountMatches(plan: PaidPlan, sum: number | null | undefined): boolean {
  if (sum == null || Number.isNaN(sum)) return false;
  return sum >= priceFor(plan) - 0.5;
}
