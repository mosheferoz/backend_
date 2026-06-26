import { grow, tokenQueryIndicatesPaid, isGrowSuccess } from "../lib/grow.js";
import * as billing from "../lib/billing.js";
import { priceFor, type PaidPlan } from "../lib/plans.js";
import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { logger } from "../lib/logger.js";

export interface ReconcileSummary {
  checked: number;
  renewed: number;
  failed: number;
}

/**
 * Resolve renewal charges left in 'pending' (process crashed / network timeout
 * mid-charge). The transactionUniqueIdentifier lets us ask Grow what actually
 * happened, so we never double-charge on the next renewal pass.
 */
// Guard against overlapping runs in the same process (node-cron doesn't skip a
// still-running job). Reconcile takes no DB row-lock, so two concurrent passes
// over the same 'pending' rows would double-apply increments — this prevents it.
let reconcileRunning = false;

export async function runReconcile(): Promise<ReconcileSummary> {
  if (reconcileRunning) {
    logger.warn("reconcile_already_running_skip");
    return { checked: 0, renewed: 0, failed: 0 };
  }
  reconcileRunning = true;
  try {
    return await reconcileInner();
  } finally {
    reconcileRunning = false;
  }
}

async function reconcileInner(): Promise<ReconcileSummary> {
  const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("subscription_payments")
    .select("user_id, plan, amount, transaction_unique_id, kind")
    .eq("status", "pending")
    .in("kind", ["renewal", "upgrade"])
    .lt("created_at", cutoff)
    .limit(100);
  if (error) throw new Error(`reconcile: ${error.message}`);

  let renewed = 0;
  let failed = 0;

  for (const p of (data ?? []) as Array<Record<string, unknown>>) {
    const userId = String(p.user_id);
    const uniqueId = p.transaction_unique_id as number | null;
    const kind = String(p.kind);
    const plan = p.plan as PaidPlan;
    try {
      const pm = await billing.getPaymentMethod(userId);
      if (!pm || !pm.token || uniqueId == null) {
        if (uniqueId != null) {
          await billing.finalizePayment(uniqueId, { status: "failed", errorText: "reconcile_no_token" });
        }
        failed++;
        continue;
      }
      const q = await grow.getTokenTransactionsByExternalIdentifiers({
        cardToken: pm.token,
        transactionUniqueIdentifier: uniqueId,
      });
      // Transport failure ("couldn't reach Grow") is NOT the same as "Grow says
      // not paid". Treating it as a failure here would dun/downgrade paying
      // customers during a Grow outage (and, if the charge actually succeeded,
      // charge them AND revoke access). Leave the row 'pending' for a later pass.
      const unreachable =
        !isGrowSuccess(q) &&
        (q?.err?.message === "network_error" || q?.err?.message === "invalid_json");

      if (tokenQueryIndicatesPaid(q)) {
        const amount = (p.amount as number) ?? priceFor(plan);
        if (kind === "upgrade") {
          // A prorated upgrade charge went through — apply the plan switch.
          await billing.applyUpgrade(userId, plan);
        } else {
          // Renewal: extend the period; `plan` carries any scheduled downgrade.
          await billing.renewSubscription(userId, amount, plan);
        }
        await billing.incrementChargeCount(userId);
        await billing.finalizePayment(uniqueId, { status: "success" });
        renewed++;
      } else if (unreachable) {
        logger.warn({ userId, uniqueId }, "reconcile_unreachable_left_pending");
        // Intentionally do nothing: not success, not failure — retry next pass.
      } else {
        await billing.finalizePayment(uniqueId, { status: "failed", errorText: "reconcile_not_found" });
        // A failed renewal enters dunning; a failed upgrade must NOT — the
        // existing subscription is untouched.
        if (kind === "renewal") {
          await billing.recordRenewalFailure(userId, "reconcile_not_found", false);
        }
        failed++;
      }
    } catch (e) {
      logger.error({ err: String(e), userId }, "reconcile_exception");
    }
  }

  return { checked: data?.length ?? 0, renewed, failed };
}
