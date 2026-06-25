import { grow, tokenQueryIndicatesPaid } from "../lib/grow.js";
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
export async function runReconcile(): Promise<ReconcileSummary> {
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
