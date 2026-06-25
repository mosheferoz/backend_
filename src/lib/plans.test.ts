import { describe, it, expect } from "vitest";
import { isPaidPlan, priceFor, amountMatches, prorationDelta, PROMO_CHARGES } from "./plans";

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
