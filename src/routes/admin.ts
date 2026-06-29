import { Hono, type Context } from "hono";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { requireAuth, requireAdmin, isAdminEmail, type AppEnv } from "../lib/auth.js";
import { rateLimit } from "../lib/rateLimit.js";
import { grow, isGrowSuccess } from "../lib/grow.js";
import * as billing from "../lib/billing.js";
import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { recordAdminAction, type AdminAction } from "../lib/audit.js";
import { logger } from "../lib/logger.js";

/**
 * Admin actions. Gated by identity (requireAuth + requireAdmin email allowlist),
 * NOT the cron-secret. Every mutation is audit-logged. Card tokens are never
 * exposed; Grow is only called for refunds (change-plan/comp never charge).
 */
export const adminRoute = new Hono<AppEnv>();

adminRoute.use("*", rateLimit({ windowMs: 60_000, max: 60, keyPrefix: "admin" }));
adminRoute.use("*", requireAuth);

// /me must answer for ANY authenticated user (so the client can tell admin from
// non-admin) — register it BEFORE the requireAdmin gate.
adminRoute.get("/me", (c) => {
  const user = c.get("user");
  return c.json({ ok: true, admin: isAdminEmail(user.email), email: user.email ?? null });
});

// Everything below is admin-only.
adminRoute.use("*", requireAdmin);

// --- helpers ---------------------------------------------------------------
const UUID = z.string().uuid();

function reqMeta(c: Context<AppEnv>) {
  return {
    ip:
      c.req.header("x-real-ip") ||
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      null,
    userAgent: c.req.header("user-agent") || null,
  };
}

async function audit(
  c: Context<AppEnv>,
  action: AdminAction,
  targetUserId: string,
  details?: Record<string, unknown>,
) {
  const u = c.get("user");
  const { ip, userAgent } = reqMeta(c);
  await recordAdminAction({
    adminEmail: u.email ?? "unknown",
    adminUserId: u.id,
    action,
    targetUserId,
    details,
    ip,
    userAgent,
  });
}

type Row = Record<string, unknown>;
const str = (v: unknown) => (v == null ? null : String(v));
const num = (v: unknown) => (v == null ? null : Number(v));

function mapUserRow(r: Row) {
  return {
    id: String(r.user_id),
    email: str(r.email),
    name: str(r.full_name),
    businessName: str(r.business_name),
    plan: (r.plan as string) ?? "free",
    status: (r.status as string) ?? "free",
    nextBillingAt: str(r.next_billing_at),
    lastPaymentAt: str(r.last_payment_at),
    lastPaymentAmount: num(r.last_payment_amount),
    cancelAtPeriodEnd: !!r.cancel_at_period_end,
    dunningStatus: str(r.dunning_status),
    isTest: !!r.is_test,
  };
}

// --- reads -----------------------------------------------------------------
adminRoute.get("/stats", async (c) => {
  const { data, error } = await supabaseAdmin.rpc("admin_billing_stats");
  if (error) {
    logger.error({ err: error.message }, "admin_stats_failed");
    return c.json({ ok: false, error: "stats_failed" }, 500);
  }
  const s = (data ?? {}) as Record<string, any>;
  const byPlan = (s.subs_by_plan ?? {}) as Record<string, number>;
  return c.json({
    ok: true,
    stats: {
      mrr: num(s.mrr_estimate) ?? 0,
      active: s.active ?? 0,
      activePaid: (byPlan.premium ?? 0) + (byPlan.pro ?? 0),
      trials: s.trialing ?? 0,
      pastDue: s.past_due ?? 0,
      revenueThisMonth: num(s.revenue_month) ?? 0,
      refundsTotal: num(s.refunds_total) ?? 0,
      storageRevenue: num(s.storage_addon_revenue) ?? 0,
      chargesSuccess30d: s.charges_success_30d ?? 0,
      chargesFailed30d: s.charges_failed_30d ?? 0,
      churn30d: s.churn_30d ?? 0,
      trialToPaid: s.trial_to_paid ?? 0,
      revenueByMonth: ((s.revenue_6mo ?? []) as Row[]).map((r) => ({
        month: String(r.month),
        gross: Number(r.gross ?? 0),
        refunds: Number(r.refunds ?? 0),
        net: Number(r.gross ?? 0) - Number(r.refunds ?? 0),
      })),
      planDistribution: Object.entries(byPlan).map(([plan, count]) => ({ plan, count: Number(count) })),
    },
  });
});

adminRoute.get("/users", async (c) => {
  const q = c.req.query();
  const page = Math.max(1, Number.parseInt(q.page ?? "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(q.pageSize ?? "20", 10) || 20));
  const from = (page - 1) * pageSize;

  let query = supabaseAdmin.from("admin_user_overview").select("*", { count: "exact" });
  if (q.plan) query = query.eq("plan", q.plan);
  if (q.status) query = query.eq("status", q.status);
  if (q.query) {
    const term = `%${q.query.replace(/[%,]/g, "")}%`;
    query = query.or(`email.ilike.${term},full_name.ilike.${term},business_name.ilike.${term}`);
  }
  query = query.order("signed_up_at", { ascending: false }).range(from, from + pageSize - 1);

  const { data, count, error } = await query;
  if (error) {
    logger.error({ err: error.message }, "admin_users_failed");
    return c.json({ ok: false, error: "users_failed" }, 500);
  }
  return c.json({
    ok: true,
    rows: (data ?? []).map(mapUserRow),
    total: count ?? 0,
    page,
    pageSize,
  });
});

adminRoute.get("/users/:userId", async (c) => {
  const parsed = UUID.safeParse(c.req.param("userId"));
  if (!parsed.success) return c.json({ ok: false, error: "invalid_request" }, 400);
  const userId = parsed.data;

  const { data: row } = await supabaseAdmin
    .from("admin_user_overview")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (!row) return c.json({ ok: false, error: "not_found" }, 404);

  const { data: ledger } = await supabaseAdmin
    .from("subscription_payments")
    .select("id, kind, amount, status, created_at, asmachta, invoice_url")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(50);

  const pm = await billing.getPaymentMethodSummary(userId);

  return c.json({
    ok: true,
    profile: {
      id: userId,
      email: str(row.email),
      name: str(row.full_name),
      businessName: str(row.business_name),
      businessId: str(row.business_id),
      phone: str(row.phone),
      signedUpAt: str(row.signed_up_at),
      lastSignInAt: str(row.last_sign_in_at),
      storageLimit: num(row.storage_limit),
      storageUsed: num(row.storage_used),
    },
    subscription: {
      plan: (row.plan as string) ?? "free",
      status: (row.status as string) ?? "free",
      trialEndsAt: str(row.trial_ends_at),
      purchasedAt: str(row.purchased_at),
      nextBillingAt: str(row.next_billing_at),
      expiresAt: str(row.expires_at),
      cancelAtPeriodEnd: !!row.cancel_at_period_end,
      pendingPlan: str(row.pending_plan),
      failedChargeCount: num(row.failed_charge_count) ?? 0,
      dunningStatus: str(row.dunning_status),
      cardSuffix: str(row.card_suffix),
      cardBrand: str(row.card_brand),
      isTest: !!row.is_test,
    },
    paymentMethod: pm,
    ledger: (ledger ?? []).map((p) => ({
      id: String(p.id),
      kind: String(p.kind),
      amount: num(p.amount),
      status: String(p.status),
      createdAt: str(p.created_at),
      asmachta: str(p.asmachta),
      invoiceUrl: str(p.invoice_url),
    })),
  });
});

// --- mutations -------------------------------------------------------------
/** Parse :userId or null. */
function paramUserId(c: Context<AppEnv>): string | null {
  const parsed = UUID.safeParse(c.req.param("userId"));
  return parsed.success ? parsed.data : null;
}

adminRoute.post("/users/:userId/cancel", async (c) => {
  const userId = paramUserId(c);
  if (!userId) return c.json({ ok: false, error: "invalid_request" }, 400);
  await billing.setCancelAtPeriodEnd(userId, true);
  await audit(c, "cancel", userId);
  return c.json({ ok: true });
});

adminRoute.post("/users/:userId/resume", async (c) => {
  const userId = paramUserId(c);
  if (!userId) return c.json({ ok: false, error: "invalid_request" }, 400);
  await billing.setCancelAtPeriodEnd(userId, false);
  await audit(c, "resume", userId);
  return c.json({ ok: true });
});

const ChangePlanBody = z.object({
  plan: z.enum(["free", "premium", "pro"]),
  mode: z.enum(["immediate", "scheduled"]).default("immediate"),
});
adminRoute.post("/users/:userId/change-plan", async (c) => {
  const userId = paramUserId(c);
  if (!userId) return c.json({ ok: false, error: "invalid_request" }, 400);
  const body = ChangePlanBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ ok: false, error: "invalid_request" }, 400);
  const { plan: target, mode } = body.data;

  const { data: sub } = await supabaseAdmin
    .from("subscriptions")
    .select("plan, status, pending_plan")
    .eq("user_id", userId)
    .maybeSingle();
  if (!sub) return c.json({ ok: false, error: "no_subscription" }, 404);
  const current = sub.plan as string;

  // Manual downgrade to free (immediate, no charge, no dunning taint).
  if (target === "free") {
    if (current === "free") return c.json({ ok: true, effect: "noop" });
    await billing.downgradeToFreeAdmin(userId);
    await audit(c, "change_plan", userId, { from: current, to: "free", mode: "immediate", effect: "downgraded_free" });
    return c.json({ ok: true, effect: "downgraded_free" });
  }

  const paid = target; // "premium" | "pro"
  let effect: string;
  if (current === paid) {
    if (sub.pending_plan) {
      await billing.clearPendingPlan(userId);
      effect = "pending_cleared";
    } else {
      effect = "noop";
    }
  } else if (mode === "scheduled") {
    await billing.schedulePlanChange(userId, paid);
    effect = "scheduled_period_end";
  } else if (sub.status === "trialing") {
    await billing.changePlanImmediate(userId, paid);
    effect = "immediate_trial";
  } else if (current === "free" || sub.status !== "active") {
    // Manually turn a non-paying user into an active subscriber (no charge).
    await billing.grantPaidPlanAdmin(userId, paid);
    effect = "granted_no_charge";
  } else {
    // Immediate plan set WITHOUT a Grow charge (admin override); next renewal
    // bills the new plan. Anchor untouched.
    await billing.applyUpgrade(userId, paid);
    effect = "immediate_no_charge";
  }

  await audit(c, "change_plan", userId, { from: current, to: paid, mode, effect });
  return c.json({ ok: true, effect });
});

const CompBody = z.discriminatedUnion("type", [
  z.object({ type: z.literal("free_month") }),
  z.object({ type: z.literal("storage_gb"), value: z.number().int().min(1).max(1000) }),
]);
adminRoute.post("/users/:userId/comp", async (c) => {
  const userId = paramUserId(c);
  if (!userId) return c.json({ ok: false, error: "invalid_request" }, 400);
  const body = CompBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ ok: false, error: "invalid_request" }, 400);

  if (body.data.type === "free_month") {
    const r = await billing.compFreeMonth(userId);
    if (!r.ok) return c.json({ ok: false, error: r.error ?? "comp_failed" }, 409);
    await audit(c, "comp_free_month", userId, {});
    return c.json({ ok: true, type: "free_month" });
  }

  const gb = body.data.value;
  await billing.grantStoragePurchase(userId, gb);
  await billing.recordPayment({
    userId,
    plan: `storage_${gb}gb`,
    amount: 0,
    kind: "comp",
    status: "success",
    providerTxnId: `comp:${randomUUID()}`,
  });
  await audit(c, "comp_storage", userId, { gb });
  return c.json({ ok: true, type: "storage_gb", gb });
});

const SetTestBody = z.object({ isTest: z.boolean() });
adminRoute.post("/users/:userId/set-test", async (c) => {
  const userId = paramUserId(c);
  if (!userId) return c.json({ ok: false, error: "invalid_request" }, 400);
  const body = SetTestBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ ok: false, error: "invalid_request" }, 400);

  const { error } = await supabaseAdmin
    .from("subscriptions")
    .update({ is_test: body.data.isTest })
    .eq("user_id", userId);
  if (error) {
    logger.error({ err: error.message, userId }, "admin_set_test_failed");
    return c.json({ ok: false, error: "set_test_failed" }, 500);
  }
  await audit(c, "set_test", userId, { isTest: body.data.isTest });
  return c.json({ ok: true, isTest: body.data.isTest });
});

adminRoute.post("/users/:userId/invalidate-card", async (c) => {
  const userId = paramUserId(c);
  if (!userId) return c.json({ ok: false, error: "invalid_request" }, 400);
  await billing.invalidatePaymentMethod(userId);
  await audit(c, "invalidate_card", userId);
  return c.json({ ok: true });
});

adminRoute.post("/users/:userId/clear-dunning", async (c) => {
  const userId = paramUserId(c);
  if (!userId) return c.json({ ok: false, error: "invalid_request" }, 400);
  await billing.clearDunningOnCardUpdate(userId);
  await audit(c, "clear_dunning", userId);
  return c.json({ ok: true });
});

// --- refund (shared by both routes) ---------------------------------------
async function handleRefund(c: Context<AppEnv>, userId: string) {
  const charge = await billing.getRefundableCharge(userId);
  if (!charge) return c.json({ ok: false, error: "not_refundable" }, 409);

  const res = await grow.refundTransaction({
    transactionId: charge.providerTxnId,
    transactionToken: charge.providerTxnToken,
    refundSum: charge.amount,
    stopDirectDebit: true,
  });
  if (!isGrowSuccess(res)) {
    logger.warn({ userId, err: res.err }, "admin_refund_failed");
    return c.json({ ok: false, error: "refund_failed" }, 502);
  }

  await billing.recordRefund({
    userId,
    plan: charge.plan,
    amount: charge.amount,
    refundedTxnId: charge.providerTxnId,
  });
  await billing.downgradeToFreeImmediate(userId);
  await audit(c, "refund", userId, { amount: charge.amount });
  return c.json({ ok: true, refundedAmount: charge.amount });
}

adminRoute.post("/users/:userId/refund", async (c) => {
  const userId = paramUserId(c);
  if (!userId) return c.json({ ok: false, error: "invalid_request" }, 400);
  return handleRefund(c, userId);
});

// Deprecated alias (body {userId}); kept for backward compatibility.
const RefundBody = z.object({ userId: z.string().uuid() });
adminRoute.post("/refund", async (c) => {
  const parsed = RefundBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: false, error: "invalid_request" }, 400);
  return handleRefund(c, parsed.data.userId);
});
