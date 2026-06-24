import { describe, it, expect } from "vitest";
import { isPaidPlan, priceFor, amountMatches, PROMO_CHARGES } from "./plans";

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
});
