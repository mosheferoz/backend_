import { describe, it, expect } from "vitest";
import {
  isPaidPlan,
  priceFor,
  amountMatches,
  prorationDelta,
  applyDiscount,
  expectedChargeFor,
  MIN_CHARGE_AMOUNT,
  PROMO_CHARGES,
} from "./plans";

describe("plans", () => {
  it("identifies paid plans", () => {
    expect(isPaidPlan("premium")).toBe(true);
    expect(isPaidPlan("pro")).toBe(true);
    expect(isPaidPlan("free")).toBe(false);
    expect(isPaidPlan(null)).toBe(false);
    expect(isPaidPlan(undefined)).toBe(false);
  });

  it("returns the promo price for the first 3 cycles", () => {
    expect(priceFor("premium")).toBe(49); // defaults to cycle 1
    expect(priceFor("premium", 1)).toBe(49);
    expect(priceFor("premium", 3)).toBe(49);
    expect(priceFor("pro", 1)).toBe(99);
    expect(priceFor("pro", 3)).toBe(99);
  });

  it("returns the regular price from the 4th cycle onward", () => {
    expect(priceFor("premium", PROMO_CHARGES + 1)).toBe(149);
    expect(priceFor("premium", 12)).toBe(149);
    expect(priceFor("pro", PROMO_CHARGES + 1)).toBe(249);
    expect(priceFor("pro", 12)).toBe(249);
  });

  it("amountMatches guards against undercharge / tampering per cycle", () => {
    // promo cycle
    expect(amountMatches("pro", 99, 1)).toBe(true);
    expect(amountMatches("pro", 98.6, 1)).toBe(true); // rounding tolerance
    expect(amountMatches("pro", 49, 1)).toBe(false); // under promo price
    // regular cycle — promo amount must NOT pass once regular price applies
    expect(amountMatches("pro", 249, 4)).toBe(true);
    expect(amountMatches("pro", 99, 4)).toBe(false); // undercharge at regular tier
    // premium
    expect(amountMatches("premium", 49, 1)).toBe(true);
    expect(amountMatches("premium", 149, 4)).toBe(true);
    expect(amountMatches("premium", 49, 4)).toBe(false);
    // invalid
    expect(amountMatches("premium", NaN)).toBe(false);
    expect(amountMatches("premium", null)).toBe(false);
  });

  it("amountMatches rejects a silent overcharge above the regular price", () => {
    expect(amountMatches("premium", 200, 1)).toBe(false); // > 149 + 0.5
    expect(amountMatches("pro", 300, 1)).toBe(false); // > 249 + 0.5 (e.g. VAT added on top)
    expect(amountMatches("premium", 149.5, 4)).toBe(true); // at the upper bound
  });

  it("amountMatches rejects the full/VAT-inflated price during the promo window", () => {
    // Cycle 1 expects promo; the regular price (or VAT-on-top) must NOT pass.
    expect(amountMatches("premium", 149, 1)).toBe(false); // full regular at promo cycle
    expect(amountMatches("pro", 249, 1)).toBe(false);
    expect(amountMatches("premium", 57.82, 1)).toBe(false); // 49 + 18% VAT on top
    expect(amountMatches("pro", 116.82, 1)).toBe(false); // 99 + 18% VAT on top
  });

  describe("applyDiscount / expectedChargeFor (coupons)", () => {
    it("passes the base price through unchanged with no discount", () => {
      expect(applyDiscount(49)).toBe(49);
      expect(applyDiscount(49, null)).toBe(49);
      expect(applyDiscount(49, undefined)).toBe(49);
    });

    it("applies a percent discount", () => {
      expect(applyDiscount(49, { discountType: "percent", discountValue: 20 })).toBe(39.2);
      expect(applyDiscount(100, { discountType: "percent", discountValue: 50 })).toBe(50);
    });

    it("applies a fixed-amount discount", () => {
      expect(applyDiscount(49, { discountType: "fixed", discountValue: 10 })).toBe(39);
    });

    it("clamps to MIN_CHARGE_AMOUNT — never 0 or negative", () => {
      expect(applyDiscount(49, { discountType: "percent", discountValue: 100 })).toBe(MIN_CHARGE_AMOUNT);
      expect(applyDiscount(49, { discountType: "fixed", discountValue: 1000 })).toBe(MIN_CHARGE_AMOUNT);
    });

    it("never returns more than the base price", () => {
      // A pathological/negative-value discount should not be able to inflate the charge.
      expect(applyDiscount(49, { discountType: "fixed", discountValue: -10 })).toBeLessThanOrEqual(49);
    });

    it("expectedChargeFor composes priceFor with the discount", () => {
      expect(expectedChargeFor("pro", 1, { discountType: "percent", discountValue: 10 })).toBe(89.1);
      expect(expectedChargeFor("pro", 4, { discountType: "percent", discountValue: 10 })).toBe(224.1);
      expect(expectedChargeFor("pro", 1)).toBe(priceFor("pro", 1));
    });
  });

  describe("amountMatches with a coupon discount", () => {
    it("requires the discounted amount, not the full price", () => {
      const discount = { discountType: "percent" as const, discountValue: 20 };
      expect(amountMatches("premium", 39.2, 1, discount)).toBe(true);
      // The undiscounted promo price must now FAIL — proves a stale/spoofed
      // full-price payload can't sneak a discounted redemption through.
      expect(amountMatches("premium", 49, 1, discount)).toBe(false);
    });

    it("respects the MIN_CHARGE_AMOUNT floor for a large discount", () => {
      const discount = { discountType: "percent" as const, discountValue: 100 };
      expect(amountMatches("premium", MIN_CHARGE_AMOUNT, 1, discount)).toBe(true);
    });

    it("omitting the discount reproduces the no-coupon behavior exactly", () => {
      expect(amountMatches("pro", 99, 1)).toBe(amountMatches("pro", 99, 1, null));
      expect(amountMatches("pro", 49, 1)).toBe(amountMatches("pro", 49, 1, undefined));
    });
  });

  describe("prorationDelta", () => {
    it("charges the full price difference for a full period remaining", () => {
      // promo cycle: pro 99 - premium 49 = 50
      expect(prorationDelta("premium", "pro", 1, 30, 30)).toBe(50);
      // regular cycle: 249 - 149 = 100
      expect(prorationDelta("premium", "pro", 4, 30, 30)).toBe(100);
    });

    it("prorates by the unused fraction of the period", () => {
      expect(prorationDelta("premium", "pro", 1, 15, 30)).toBe(25); // half left
      expect(prorationDelta("premium", "pro", 4, 6, 30)).toBe(20); // 1/5 left of 100
    });

    it("handles a 28-day (February) period without exceeding the full delta", () => {
      // full period left in a 28-day month -> full delta, not more.
      expect(prorationDelta("premium", "pro", 1, 28, 28)).toBe(50);
    });

    it("clamps the ratio to [0,1] and never goes negative or > full", () => {
      expect(prorationDelta("premium", "pro", 1, 0, 30)).toBe(0); // nothing left
      expect(prorationDelta("premium", "pro", 1, -5, 30)).toBe(0); // overdue
      expect(prorationDelta("premium", "pro", 1, 40, 30)).toBe(50); // clamps to full
    });

    it("returns 0 for a downgrade (no negative delta)", () => {
      expect(prorationDelta("pro", "premium", 1, 15, 30)).toBe(0);
    });

    it("returns 0 when the period length is invalid", () => {
      expect(prorationDelta("premium", "pro", 1, 15, 0)).toBe(0);
    });

    it("rounds to 2 decimals (agorot)", () => {
      // 50 * (10/30) = 16.666... -> 16.67
      expect(prorationDelta("premium", "pro", 1, 10, 30)).toBe(16.67);
    });
  });
});
