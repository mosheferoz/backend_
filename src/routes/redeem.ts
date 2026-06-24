import { Hono } from "hono";
import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import { requireAuth, type AppEnv } from "../lib/auth.js";
import { rateLimit } from "../lib/rateLimit.js";
import { config } from "../config.js";
import type { PaidPlan } from "../lib/plans.js";
import { grantTesterAccess, recordPayment } from "../lib/billing.js";
import { logger } from "../lib/logger.js";

/**
 * TEMPORARY tester bypass. Lets a tester unlock a paid plan with a secret code,
 * WITHOUT going through Grow — for use until billing is fully approved/live.
 * Disabled automatically when TESTER_CODE is empty. Remove this route when done.
 *
 * Valid only until launch (1.7.2026): redemption is blocked afterwards, and any
 * access granted expires on that date.
 */
const TESTER_ACCESS_UNTIL = new Date("2026-07-01T21:00:00Z"); // 2026-07-02 00:00 Asia/Jerusalem

const Body = z.object({
  plan: z.enum(["premium", "pro"]),
  code: z.string().min(1).max(100),
});

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export const redeemRoute = new Hono<AppEnv>();

redeemRoute.use("*", rateLimit({ windowMs: 60_000, max: 5, keyPrefix: "redeem" }));
redeemRoute.use("*", requireAuth);

redeemRoute.post("/", async (c) => {
  if (!config.testerCode) return c.json({ ok: false, error: "disabled" }, 403);
  if (new Date() >= TESTER_ACCESS_UNTIL) return c.json({ ok: false, error: "expired" }, 403);

  const parsed = Body.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: false, error: "invalid_request" }, 400);
  const { plan, code } = parsed.data;
  const user = c.get("user");

  if (!safeEqual(code.trim(), config.testerCode)) {
    return c.json({ ok: false, error: "invalid_code" }, 403);
  }

  await grantTesterAccess(user.id, plan as PaidPlan, TESTER_ACCESS_UNTIL);
  await recordPayment({
    userId: user.id,
    plan,
    amount: 0,
    kind: "subscribe",
    status: "success",
    errorText: "tester_code",
  });
  logger.info({ userId: user.id, plan }, "tester_code_redeemed");
  return c.json({ ok: true });
});
