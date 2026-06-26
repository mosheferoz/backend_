import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { sendEmail, trialReminderHtml } from "../lib/mail.js";
import * as billing from "../lib/billing.js";
import { priceFor, PLAN_LABELS, isPaidPlan } from "../lib/plans.js";
import { logger } from "../lib/logger.js";

const DAY_MS = 86_400_000;

/**
 * Email trialing users ~2 days before their first charge. Idempotent: only rows
 * with trial_reminder_sent_at IS NULL are picked, and the flag is set only after
 * a successful send (so a transient email failure retries next pass; an unset
 * RESEND_API_KEY simply never sends and never marks — no spam).
 */
export async function runTrialReminders(): Promise<number> {
  const now = new Date();
  const soon = new Date(now.getTime() + 2 * DAY_MS);
  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select("user_id, plan, trial_ends_at")
    .eq("status", "trialing")
    .is("trial_reminder_sent_at", null)
    .gt("trial_ends_at", now.toISOString())
    .lte("trial_ends_at", soon.toISOString())
    .limit(100);
  if (error) {
    logger.error({ err: error.message }, "trial_reminders_query_failed");
    return 0;
  }

  let sent = 0;
  for (const s of data ?? []) {
    const plan = s.plan as string;
    if (!isPaidPlan(plan)) continue;
    const contact = await billing.getProfileBillingContact(s.user_id as string);
    if (!contact.email) continue;

    const cycle = await billing.nextChargeCycle(s.user_id as string);
    const priceHe = `₪${priceFor(plan, cycle)} לחודש`;
    const endHe = new Date(s.trial_ends_at as string).toLocaleDateString("he-IL");

    const ok = await sendEmail(
      contact.email,
      "תקופת הניסיון שלך מסתיימת בקרוב",
      trialReminderHtml(contact.fullName, PLAN_LABELS[plan], endHe, priceHe),
    );
    if (ok) {
      await supabaseAdmin
        .from("subscriptions")
        .update({ trial_reminder_sent_at: now.toISOString() })
        .eq("user_id", s.user_id);
      sent++;
    }
  }
  if (sent) logger.info({ sent }, "trial_reminders_sent");
  return sent;
}
