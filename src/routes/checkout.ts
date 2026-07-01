import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AppEnv } from "../lib/auth.js";
import { rateLimit, rateLimitByUser } from "../lib/rateLimit.js";
import { grow, ChargeType, isGrowSuccess } from "../lib/grow.js";
import { priceFor, applyDiscount, isPaidPlan, PLAN_LABELS } from "../lib/plans.js";
import { recordConsent, getProfileBillingContact, nextChargeCycle } from "../lib/billing.js";
import { redeemCoupon, previewCoupon } from "../lib/coupons.js";
import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { isValidILMobile, normalizeILPhone } from "../lib/phone.js";
import { growNotifyUrl, growInvoiceNotifyUrl, successUrl, cancelUrl } from "../lib/urls.js";
import { logger } from "../lib/logger.js";

/** Bump when the consent wording changes (stored with each consent record). */
export const CONSENT_TEXT_VERSION = "2026-06-23-v1";

const Body = z.object({
  plan: z.enum(["premium", "pro"]),
  mode: z.enum(["subscribe", "trial"]).default("subscribe"),
  consent: z.literal(true),
  phone: z.string().trim().max(20).optional(),
  invoiceName: z.string().trim().max(120).optional(),
  invoiceLicenseNumber: z.string().trim().max(40).optional(),
  couponCode: z.string().trim().min(1).max(40).optional(),
});

export const checkoutRoute = new Hono<AppEnv>();

checkoutRoute.use("*", rateLimit({ windowMs: 60_000, max: 10, keyPrefix: "checkout" }));
checkoutRoute.use("*", requireAuth);

checkoutRoute.post("/", async (c) => {
  const parsed = Body.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: false, error: "invalid_request" }, 400);
  const { plan, mode, invoiceName, invoiceLicenseNumber, couponCode } = parsed.data;
  const user = c.get("user");

  // Guard against a duplicate charge: an active/trial paid subscriber must use
  // the change-plan flow, not a fresh checkout (which would charge again and
  // reset the billing period). Lapsed (free) and past_due users may re-checkout.
  const { data: existing } = await supabaseAdmin
    .from("subscriptions")
    .select("plan, status")
    .eq("user_id", user.id)
    .maybeSingle();
  if (
    (existing?.status === "active" || existing?.status === "trialing") &&
    (existing?.plan === "premium" || existing?.plan === "pro")
  ) {
    return c.json({ ok: false, error: "already_subscribed" }, 409);
  }

  const contact = await getProfileBillingContact(user.id);

  // Grow requires a valid Israeli phone (else err 946). Prefer a phone supplied
  // by the checkout dialog, fall back to the profile; reject if neither is valid
  // so the UI can prompt for one.
  const phone = normalizeILPhone(parsed.data.phone || contact.phone || "");
  if (!isValidILMobile(phone)) {
    return c.json({ ok: false, error: "invalid_phone" }, 400);
  }
  if (phone !== normalizeILPhone(contact.phone || "")) {
    await supabaseAdmin.from("profiles").update({ phone }).eq("user_id", user.id);
  }

  // Legal consent log — the customer agreed the card is stored for future charges.
  await recordConsent({
    userId: user.id,
    plan,
    consentTextVersion: CONSENT_TEXT_VERSION,
    ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: c.req.header("user-agent") ?? null,
  });

  // Promo price for the first 3 paid charges, regular afterwards (re-subscribe).
  const cycle = await nextChargeCycle(user.id);
  const price = priceFor(plan, cycle);

  // Coupon redemption MUST happen before the Grow call, since the discounted
  // sum is what gets sent to the hosted checkout. The reservation applies
  // regardless of trial/subscribe — for a trial it's confirmed now (no charge
  // yet) and consumed later at trial-conversion inside the renewal job.
  let redemptionId: string | undefined;
  let discountedPrice = price;
  if (couponCode) {
    const redeemed = await redeemCoupon(couponCode, user.id, plan, cycle);
    if (!redeemed.ok) return c.json({ ok: false, error: redeemed.error }, 400);
    redemptionId = redeemed.coupon.redemptionId;
    discountedPrice = applyDiscount(price, redeemed.coupon.discount);
  }

  // Trial = save the card without charging (chargeType=3). Grow rejects sum=0,
  // so we show a ₪1 reference on the token-save page; the real ₪price (already
  // discounted, if a coupon was applied) is charged at trial end via
  // createTransactionWithToken.
  const sum = mode === "trial" ? 1 : discountedPrice;
  const description =
    mode === "trial"
      ? `התחלת ניסיון — מסלול ${PLAN_LABELS[plan]} (קונטרול בקליק)`
      : `מנוי ${PLAN_LABELS[plan]} — קונטרול בקליק`;

  const res = await grow.createPaymentProcess({
    chargeType: mode === "trial" ? ChargeType.SAVE_TOKEN_ONLY : ChargeType.SUBSCRIBE,
    sum,
    description,
    fullName: contact.fullName,
    phone,
    email: contact.email ?? user.email ?? undefined,
    successUrl: successUrl(plan, mode),
    cancelUrl: cancelUrl(),
    notifyUrl: growNotifyUrl(),
    invoiceNotifyUrl: growInvoiceNotifyUrl(),
    saveToken: true,
    cField1: user.id,
    cField2: plan,
    cField3: mode,
    cField4: redemptionId,
    invoiceName: invoiceName ?? contact.businessName ?? contact.fullName,
    invoiceLicenseNumber: invoiceLicenseNumber ?? contact.businessId ?? undefined,
  });

  if (!isGrowSuccess(res) || !res.data?.url) {
    logger.error({ res, userId: user.id, plan, mode }, "create_payment_process_failed");
    return c.json({ ok: false, error: "payment_init_failed" }, 502);
  }
  return c.json({ ok: true, url: res.data.url });
});

// Live "apply code" check in the checkout dialog. Read-only (no reservation —
// see previewCoupon's own doc comment for why), so it gets its own tighter
// per-user budget instead of sharing the real-checkout IP limiter above: a
// user probing codes shouldn't throttle their own purchase attempt, and a
// real purchase burst shouldn't get mistaken for enumeration.
const ValidateCouponBody = z.object({
  code: z.string().trim().min(1).max(40),
  plan: z.enum(["premium", "pro"]),
});

checkoutRoute.post(
  "/validate-coupon",
  rateLimitByUser({ windowMs: 60_000, max: 15, keyPrefix: "coupon-validate" }),
  async (c) => {
    const parsed = ValidateCouponBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: "invalid_request" }, 400);
    const { code, plan } = parsed.data;
    if (!isPaidPlan(plan)) return c.json({ ok: false, error: "invalid_request" }, 400);
    const user = c.get("user");
    const cycle = await nextChargeCycle(user.id);
    const result = await previewCoupon(code, user.id, plan, cycle);
    if (!result.ok) return c.json(result, 400);
    return c.json(result);
  },
);
