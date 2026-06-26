import cron from "node-cron";
import { runRenewals } from "./renew.js";
import { runReconcile } from "./reconcile.js";
import { runTrialReminders } from "./notifications.js";
import { logger } from "../lib/logger.js";

/**
 * In-process scheduler — host-agnostic (no platform cron required). Returns a
 * stop function for graceful shutdown. An external cron may also drive the
 * /internal endpoints instead, if preferred.
 */
export function startScheduler(): () => void {
  // Renewals + downgrades, hourly at minute 7.
  const renew = cron.schedule("7 * * * *", () => {
    runRenewals()
      .then((r) => logger.info(r, "scheduled_renewals"))
      .catch((e) => logger.error({ err: String(e) }, "scheduled_renewals_failed"));
  });

  // Reconcile stuck 'pending' charges, every 30 minutes.
  const reconcile = cron.schedule("*/30 * * * *", () => {
    runReconcile()
      .then((r) => logger.info(r, "scheduled_reconcile"))
      .catch((e) => logger.error({ err: String(e) }, "scheduled_reconcile_failed"));
  });

  // Trial-ending reminder emails, every 6 hours.
  const reminders = cron.schedule("0 */6 * * *", () => {
    runTrialReminders()
      .then((n) => logger.info({ sent: n }, "scheduled_trial_reminders"))
      .catch((e) => logger.error({ err: String(e) }, "scheduled_trial_reminders_failed"));
  });

  logger.info("scheduler started (renewals hourly, reconcile every 30m, trial reminders every 6h)");
  return () => {
    renew.stop();
    reconcile.stop();
    reminders.stop();
  };
}
