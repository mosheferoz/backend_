import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { config } from "./config.js";
import { logger } from "./lib/logger.js";
import { checkoutRoute } from "./routes/checkout.js";
import { webhooksRoute } from "./routes/webhooks.js";
import { subscriptionRoute } from "./routes/subscription.js";
import { internalRoute } from "./routes/internal.js";
import { redeemRoute } from "./routes/redeem.js";
import { startScheduler } from "./jobs/scheduler.js";

const app = new Hono();

// --- security middleware ---
app.use("*", secureHeaders());
app.use(
  "/api/*",
  cors({
    origin: config.allowedOrigins,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 600,
  }),
);
// Webhooks are form-urlencoded and small; cap body size to blunt abuse.
app.use("*", bodyLimit({ maxSize: 256 * 1024 }));

// --- liveness/readiness ---
app.get("/health", (c) => c.json({ ok: true, ts: Date.now() }));
app.get("/", (c) => c.text("controlclick billing server"));

// --- routes ---
app.route("/api/checkout", checkoutRoute);
app.route("/webhook", webhooksRoute); // public Grow notify (registered with Grow)
app.route("/api/subscription", subscriptionRoute);
app.route("/api/redeem-code", redeemRoute); // TEMP tester bypass
app.route("/internal", internalRoute);

app.notFound((c) => c.json({ ok: false, error: "not_found" }, 404));
app.onError((err, c) => {
  logger.error({ err }, "unhandled_error");
  return c.json({ ok: false, error: "internal_error" }, 500);
});

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info(`billing server listening on :${info.port} (${config.nodeEnv})`);
});

// In-process scheduler (host-agnostic — no platform cron required).
const stopScheduler = startScheduler();

function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  stopScheduler();
  server.close(() => process.exit(0));
  // node-cron keeps the loop alive; force-exit shortly after closing the server.
  setTimeout(() => process.exit(0), 1_500).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export { app };
