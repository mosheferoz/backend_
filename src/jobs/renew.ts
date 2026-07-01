import { grow, isGrowSuccess, isDuplicateUniqueId, tokenQueryIndicatesPaid } from "../lib/grow.js";
import * as billing from "../lib/billing.js";
import { expectedChargeFor, PLAN_LABELS, MAX_TOKEN_CHARGES } from "../lib/plans.js";
import { getActiveDiscount, applyCouponCycle } from "../lib/coupons.js";
import { growInvoiceNotifyUrl } from "../lib/urls.js";
import { logger } from "../lib/logger.js";

export interface RenewalSummary {
  downgraded: number;
  processed: number;
  succeeded: number;
  failed: number;
  uncertain: number;
}

/** A definitive card-level failure — stop retrying and ask for a new card. */
function isCardError(msg?: string | null): boolean {
  if (!msg) return false;
  return /פג|חסום|גנוב|expired|blocked|stolen|declin|invalid card|כרטיס/i.test(msg);
}

/** Transport-level uncertainty — the charge may or may not have happened. */
function isUncertain(message?: string | null): boolean {
  return message === "network_error" || message === "invalid_json";
}

export async function runRenewals(): Promise<RenewalSummary> {
  const downgraded = await billing.expireOverdueSubscriptions();
  if (downgraded) logger.info({ downgraded }, "expired_overdue");

  const due = await billing.claimDueSubscriptions(50);
  let succeeded = 0;
  let failed = 0;
  let uncertain = 0;

  for (const sub of due) {
    let uniqueId: number | null = null;
    try {
      const pm = await billing.getPaymentMethod(sub.userId);
      if (!pm || !pm.isValid || !pm.token) {
        await billing.recordRenewalFailure(sub.userId, "no_valid_card", true);
        failed++;
        continue;
      }
      if (pm.chargeCount >= MAX_TOKEN_CHARGES) {
        await billing.recordRenewalFailure(sub.userId, "token_charge_limit", true);
        failed++;
        continue;
      }

      // A scheduled downgrade takes effect on this renewal: bill the new plan
      // and switch to it atomically on success.
      const effectivePlan = sub.pendingPlan ?? sub.plan;
      const planSwitch = sub.pendingPlan && sub.pendingPlan !== sub.plan ? sub.pendingPlan : undefined;

      // Promo price for the first 3 paid charges, regular from the 4th —
      // discounted further if a coupon is still active on this subscription.
      // This is also where a TRIALING user's real first charge is priced: a
      // coupon redeemed at trial-signup only gets consumed here, not earlier.
      const cycle = await billing.nextChargeCycle(sub.userId);
      const discount = await getActiveDiscount(sub.couponRedemptionId);
      const amount = expectedChargeFor(effectivePlan, cycle, discount);
      uniqueId = await billing.nextUniqueId();
      const contact = await billing.getProfileBillingContact(sub.userId);

      // Trace before charging — reconcile resolves any 'pending' left behind.
      await billing.recordPayment({
        userId: sub.userId,
        plan: effectivePlan,
        amount,
        transactionUniqueId: uniqueId,
        transactionGroupId: sub.billingGroupId,
        kind: "renewal",
        status: "pending",
      });

      const res = await grow.createTransactionWithToken({
        cardToken: pm.token,
        sum: amount,
        description: `חידוש מנוי ${PLAN_LABELS[effectivePlan]} — קונטרול בקליק`,
        fullName: contact.fullName,
        phone: contact.phone,
        email: contact.email ?? undefined,
        transactionUniqueIdentifier: uniqueId,
        transactionGroupIdentifier: sub.billingGroupId,
        invoiceNotifyUrl: growInvoiceNotifyUrl(),
        invoiceName: contact.businessName ?? contact.fullName,
        invoiceLicenseNumber: contact.businessId ?? undefined,
        cField1: sub.userId,
        cField2: effectivePlan,
        cField3: "renewal",
      });

      if (isGrowSuccess(res)) {
        const dd = (res.data ?? {}) as Record<string, unknown>;
        await billing.renewSubscription(sub.userId, amount, planSwitch);
        await billing.incrementChargeCount(sub.userId);
        if (discount && sub.couponRedemptionId) await applyCouponCycle(sub.couponRedemptionId);
        await billing.finalizePayment(uniqueId, {
          status: "success",
          providerTxnId: dd.transactionId ? String(dd.transactionId) : null,
          asmachta: dd.asmachta ? String(dd.asmachta) : null,
          cardSuffix: (dd.cardSuffix as string) ?? sub.cardSuffix,
          cardBrand: (dd.cardBrand as string) ?? null,
        });
        succeeded++;
      } else if (isDuplicateUniqueId(res)) {
        // Should not happen (fresh id each attempt) — resolve via query, don't re-charge.
        const q = await grow.getTokenTransactionsByExternalIdentifiers({
          cardToken: pm.token,
          transactionUniqueIdentifier: uniqueId,
        });
        if (tokenQueryIndicatesPaid(q)) {
          await billing.renewSubscription(sub.userId, amount, planSwitch);
          await billing.incrementChargeCount(sub.userId);
          if (discount && sub.couponRedemptionId) await applyCouponCycle(sub.couponRedemptionId);
          await billing.finalizePayment(uniqueId, { status: "success" });
          succeeded++;
        } else {
          await billing.finalizePayment(uniqueId, { status: "failed", errorText: "duplicate_unique_id" });
          await billing.recordRenewalFailure(sub.userId, "duplicate_unique_id", false);
          failed++;
        }
      } else if (isUncertain(res.err?.message)) {
        // Leave the row 'pending' for the reconcile job to resolve via query.
        // Do NOT dunning or retry now — that could double-charge.
        uncertain++;
        logger.warn({ userId: sub.userId, uniqueId }, "renewal_uncertain_left_pending");
      } else {
        const msg = res.err?.message ?? "charge_failed";
        const cardDead = isCardError(msg);
        await billing.finalizePayment(uniqueId, { status: "failed", errorText: msg });
        await billing.recordRenewalFailure(sub.userId, msg, cardDead);
        failed++;
      }
    } catch (e) {
      // Unexpected throw — treat as uncertain; reconcile will resolve the pending row.
      uncertain++;
      logger.error({ err: String(e), userId: sub.userId, uniqueId }, "renewal_exception");
    }
  }

  return { downgraded, processed: due.length, succeeded, failed, uncertain };
}
