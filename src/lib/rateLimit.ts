import type { Context, Next } from "hono";

interface Bucket {
  count: number;
  reset: number;
}

/**
 * Lightweight in-memory rate limiter (per client IP). Sufficient for a single
 * instance; for horizontal scaling back it with Redis. Keyed per route via
 * `keyPrefix` so different endpoints get independent budgets.
 */
export function rateLimit(opts: { windowMs: number; max: number; keyPrefix?: string }) {
  const hits = new Map<string, Bucket>();

  return async (c: Context, next: Next) => {
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      c.req.header("x-real-ip") ||
      "unknown";
    const key = `${opts.keyPrefix ?? ""}:${ip}`;
    const now = Date.now();

    const b = hits.get(key);
    if (!b || b.reset < now) {
      hits.set(key, { count: 1, reset: now + opts.windowMs });
    } else {
      b.count += 1;
      if (b.count > opts.max) {
        return c.json({ ok: false, error: "rate_limited" }, 429);
      }
    }

    if (hits.size > 5000) {
      for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    }

    await next();
  };
}
