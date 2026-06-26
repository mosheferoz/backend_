import type { Context, Next } from "hono";

interface Bucket {
  count: number;
  reset: number;
}

interface Opts {
  windowMs: number;
  max: number;
  keyPrefix?: string;
}

function makeLimiter(opts: Opts, keyFn: (c: Context) => string) {
  const hits = new Map<string, Bucket>();
  return async (c: Context, next: Next) => {
    const key = `${opts.keyPrefix ?? ""}:${keyFn(c)}`;
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

// The leftmost x-forwarded-for hop is client-claimed (spoofable); x-real-ip is
// set by the platform proxy, so prefer it when present.
function clientIp(c: Context): string {
  return (
    c.req.header("x-real-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

/**
 * Per-IP in-memory limiter (defense-in-depth, behind a trusted proxy). Single
 * instance; for horizontal scaling back it with Redis/DB.
 */
export function rateLimit(opts: Opts) {
  return makeLimiter(opts, clientIp);
}

/**
 * Per-authenticated-user limiter — MUST run after requireAuth. Keys on the
 * unspoofable user id, so it (not the IP limiter) is the real guard for
 * money-mutating endpoints. Falls back to IP for unauthenticated requests.
 */
export function rateLimitByUser(opts: Opts) {
  return makeLimiter(opts, (c) => {
    const user = c.get("user") as { id?: string } | undefined;
    return user?.id ?? clientIp(c);
  });
}
