import { Hono } from "hono";
import { requireAuth, type AppEnv } from "../lib/auth.js";
import { rateLimit } from "../lib/rateLimit.js";
import { grow, ChargeType, isGrowSuccess } from "../lib/grow.js";
import { isPaidPlan, priceFor, PLAN_LABELS } from "../lib/plans.js";
import { setCancelAtPeriodEnd, getProfileBillingContact } from "../lib/billing.js";
import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { growNotifyUrl, growInvoiceNotifyUrl, successUrl, cancelUrl } from "../lib/urls.js";

export const subscriptionRoute = new Hono<AppEnv>();

subscriptionRoute.use("*", rateLimit({ windowMs: 60_000, max: 20, keyPrefix: "sub" }));
subscriptionRoute.use("*", requireAuth);

subscriptionRoute.post("/cancel", async (c) => {
  await setCancelAtPeriodEnd(c.get("user").id, true);
  return c.json({ ok: true });
});

subscriptionRoute.post("/resume", async (c) => {
  await setCancelAtPeriodEnd(c.get("user").id, false);
  return c.json({ ok: true });
});

/** Issue a fresh hosted form to replace the saved card (dunning / expiry). */
subscriptionRoute.post("/update-card", async (c) => {
  const user = c.get("user");
  const { data: sub } = await supabaseAdmin
    .from("subscriptions")
    .select("plan")
    .eq("user_id", user.id)
    .maybeSingle();
  const plan = sub?.plan;
  if (!isPaidPlan(plan)) return c.json({ ok: false, error: "no_paid_plan" }, 400);

  const contact = await getProfileBillingContact(user.id);
  const res = await grow.createPaymentProcess({
    chargeType: ChargeType.SAVE_TOKEN_ONLY,
    sum: priceFor(plan),
    description: `עדכון אמצעי תשלום — ${PLAN_LABELS[plan]} (קונטרול בקליק)`,
    fullName: contact.fullName,
    phone: contact.phone,
    email: contact.email ?? user.email ?? undefined,
    successUrl: successUrl(plan, "update-card"),
    cancelUrl: cancelUrl(),
    notifyUrl: growNotifyUrl(),
    invoiceNotifyUrl: growInvoiceNotifyUrl(),
    saveToken: true,
    cField1: user.id,
    cField2: plan,
    cField3: "update_card",
  });
  if (!isGrowSuccess(res) || !res.data?.url) return c.json({ ok: false, error: "init_failed" }, 502);
  return c.json({ ok: true, url: res.data.url });
});
