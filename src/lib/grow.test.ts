import { describe, it, expect } from "vitest";
import {
  isGrowSuccess,
  isDuplicateUniqueId,
  tokenQueryIndicatesPaid,
  GROW_DUPLICATE_UNIQUE_ID_ERROR,
} from "./grow";

describe("grow response helpers", () => {
  it("detects success (status === 1)", () => {
    expect(isGrowSuccess({ status: "1" })).toBe(true);
    expect(isGrowSuccess({ status: 1 })).toBe(true);
    expect(isGrowSuccess({ status: "0" })).toBe(false);
    expect(isGrowSuccess(null)).toBe(false);
    expect(isGrowSuccess(undefined)).toBe(false);
  });

  it("detects the duplicate-unique-id error (1010)", () => {
    expect(
      isDuplicateUniqueId({ status: 0, err: { id: GROW_DUPLICATE_UNIQUE_ID_ERROR } }),
    ).toBe(true);
    expect(isDuplicateUniqueId({ status: 0, err: { id: 12 } })).toBe(false);
    expect(isDuplicateUniqueId({ status: "1" })).toBe(false);
  });

  it("interprets a token query as paid only with a real transaction", () => {
    expect(
      tokenQueryIndicatesPaid({ status: "1", data: [{ statusCode: "1", asmachta: "123" }] }),
    ).toBe(true);
    expect(
      tokenQueryIndicatesPaid({ status: "1", data: { transactions: [{ status: "approved" }] } }),
    ).toBe(true);
    expect(tokenQueryIndicatesPaid({ status: "1", data: [] })).toBe(false);
    expect(tokenQueryIndicatesPaid({ status: "0" })).toBe(false);
  });
});
