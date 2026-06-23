import { describe, it, expect } from "vitest";
import { isPaidPlan, priceFor, amountMatches } from "./plans";

describe("plans", () => {
  it("identifies paid plans", () => {
    expect(isPaidPlan("premium")).toBe(true);
    expect(isPaidPlan("pro")).toBe(true);
    expect(isPaidPlan("free")).toBe(false);
    expect(isPaidPlan(null)).toBe(false);
    expect(isPaidPlan(undefined)).toBe(false);
  });

  it("returns monthly prices", () => {
    expect(priceFor("premium")).toBe(49);
    expect(priceFor("pro")).toBe(249);
  });

  it("amountMatches guards against undercharge / tampering", () => {
    expect(amountMatches("premium", 49)).toBe(true);
    expect(amountMatches("premium", 48.6)).toBe(true); // rounding tolerance
    expect(amountMatches("premium", 40)).toBe(false);
    expect(amountMatches("pro", 249)).toBe(true);
    expect(amountMatches("pro", 49)).toBe(false); // wrong tier amount
    expect(amountMatches("premium", NaN)).toBe(false);
    expect(amountMatches("premium", null)).toBe(false);
  });
});
