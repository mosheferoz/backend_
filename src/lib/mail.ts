import { config } from "../config.js";
import { logger } from "./logger.js";

/**
 * Best-effort transactional email via Resend. Returns true only if the message
 * was accepted. No-ops (returns false) when email isn't configured or there's no
 * recipient — callers treat false as "not sent" and retry on the next pass.
 */
export async function sendEmail(to: string | null | undefined, subject: string, html: string): Promise<boolean> {
  if (!config.resendApiKey || !to) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: config.mailFrom, to, subject, html }),
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "email_send_failed");
      return false;
    }
    return true;
  } catch (e) {
    logger.warn({ err: String(e) }, "email_send_error");
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Operational alert to the team (money/fraud signals that were previously only
 * a log line). No-op if ALERT_EMAIL isn't configured; never throws.
 */
export async function alertAdmin(subject: string, detail: Record<string, unknown>): Promise<void> {
  if (!config.alertEmail) return;
  const rows = Object.entries(detail)
    .map(([k, v]) => `<tr><td style="padding:2px 8px;color:#6b7280">${k}</td><td style="padding:2px 8px">${String(v)}</td></tr>`)
    .join("");
  try {
    await sendEmail(config.alertEmail, `🚨 ${subject}`, `<h2>${subject}</h2><table>${rows}</table>`);
  } catch {
    /* alerting must never break the request path */
  }
}

const SHELL = (title: string, body: string) => `<!doctype html><html dir="rtl" lang="he"><body style="font-family:Arial,Helvetica,sans-serif;background:#f4f4f7;margin:0;padding:24px">
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:14px;padding:28px;color:#1e1b2e">
<h1 style="font-size:20px;margin:0 0 14px;color:#4c1d95">${title}</h1>
${body}
<p style="margin-top:24px;font-size:12px;color:#6b7280">קונטרול בקליק · ניהול העסק שלך במקום אחד</p>
</div></body></html>`;

export function trialReminderHtml(name: string, planLabel: string, endDateHe: string, priceHe: string): string {
  return SHELL(
    "תקופת הניסיון מסתיימת בקרוב",
    `<p>היי ${name},</p>
     <p>רצינו להזכיר שתקופת הניסיון שלך במסלול <strong>${planLabel}</strong> מסתיימת ב-<strong>${endDateHe}</strong>.</p>
     <p>בתום הניסיון יתבצע החיוב הראשון (${priceHe}) באמצעי התשלום ששמרת, והמנוי יימשך אוטומטית.</p>
     <p>לא רוצה להמשיך? אפשר לבטל בקליק מתוך עמוד הפרופיל לפני מועד החיוב — ללא כל חיוב.</p>`,
  );
}

export function dunningHtml(name: string): string {
  return SHELL(
    "חיוב המנוי נכשל — נדרשת פעולה",
    `<p>היי ${name},</p>
     <p>לא הצלחנו לחייב את אמצעי התשלום עבור חידוש המנוי. כדי לא לאבד את הגישה למסלול בתשלום, יש לעדכן אמצעי תשלום בעמוד הפרופיל בהקדם.</p>
     <p>ננסה לחייב שוב בימים הקרובים; אם החיוב לא יצליח, המנוי ירד אוטומטית למסלול החינמי בתום תקופת החסד.</p>`,
  );
}
