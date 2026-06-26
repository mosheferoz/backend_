import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

/** Constant-time string comparison for secrets (avoids timing side-channels). */
export function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * App-level AES-256-GCM encryption for card tokens at rest. This is
 * defense-in-depth on top of Supabase's disk encryption and RLS: even with
 * direct DB read access, the token is unreadable without TOKEN_ENC_KEY (held
 * only in the backend's secret manager).
 *
 * Stored format: `v1:<iv b64>:<authTag b64>:<ciphertext b64>`
 */
const KEY = (() => {
  const buf = Buffer.from(config.tokenEncKey, "base64");
  if (buf.length !== 32) {
    throw new Error("TOKEN_ENC_KEY must decode to 32 bytes (base64). Generate: openssl rand -base64 32");
  }
  return buf;
})();

export function encryptToken(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

export function decryptToken(stored: string): string {
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("decryptToken: malformed ciphertext");
  }
  const [, ivb, tagb, ctb] = parts as [string, string, string, string];
  const decipher = createDecipheriv("aes-256-gcm", KEY, Buffer.from(ivb, "base64"));
  decipher.setAuthTag(Buffer.from(tagb, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctb, "base64")), decipher.final()]).toString("utf8");
}
