import { describe, it, expect } from "vitest";
import { encryptToken, decryptToken } from "./crypto";

describe("token encryption", () => {
  it("round-trips a token and hides the plaintext", () => {
    const token = "tok_abc123XYZ";
    const enc = encryptToken(token);
    expect(enc.startsWith("v1:")).toBe(true);
    expect(enc).not.toContain(token);
    expect(decryptToken(enc)).toBe(token);
  });

  it("uses a random IV (distinct ciphertexts for same input)", () => {
    expect(encryptToken("same")).not.toBe(encryptToken("same"));
  });

  it("rejects tampered ciphertext (GCM auth)", () => {
    const enc = encryptToken("secret");
    const [v, iv, tag] = enc.split(":");
    const tampered = `${v}:${iv}:${tag}:${Buffer.from("garbage").toString("base64")}`;
    expect(() => decryptToken(tampered)).toThrow();
  });

  it("rejects malformed input", () => {
    expect(() => decryptToken("not-a-valid-blob")).toThrow();
  });
});
