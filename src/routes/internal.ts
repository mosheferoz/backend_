import { Hono } from "hono";
import { config } from "../config.js";
import { safeEqual } from "../lib/crypto.js";
import { runRenewals } from "../jobs/renew.js";
import { runReconcile } from "../jobs/reconcile.js";

/**
 * Internal endpoints for the scheduler (and as a manual fallback). Gated by a
 * cron secret so an external platform cron can also drive them if preferred.
 */
export const internalRoute = new Hono();

internalRoute.use("*", async (c, next) => {
  if (!safeEqual(c.req.header("x-cron-secret"), config.cronSecret)) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }
  await next();
});

internalRoute.post("/run-renewals", async (c) => {
  const result = await runRenewals();
  return c.json({ ok: true, ...result });
});

internalRoute.post("/reconcile", async (c) => {
  const result = await runReconcile();
  return c.json({ ok: true, ...result });
});
