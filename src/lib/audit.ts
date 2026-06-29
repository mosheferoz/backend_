import { supabaseAdmin } from "./supabaseAdmin.js";
import { logger } from "./logger.js";

export type AdminAction =
  | "refund"
  | "cancel"
  | "resume"
  | "change_plan"
  | "comp_free_month"
  | "comp_storage"
  | "invalidate_card"
  | "clear_dunning";

export interface AdminActionRecord {
  adminEmail: string;
  adminUserId?: string | null;
  action: AdminAction;
  targetUserId: string;
  details?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Append an admin action to admin_audit_log. Best-effort: called AFTER the
 * mutation succeeds, and never throws (a failed audit insert must not fail the
 * response — the action already happened). Errors are logged loudly.
 */
export async function recordAdminAction(rec: AdminActionRecord): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from("admin_audit_log").insert({
      admin_email: rec.adminEmail,
      admin_user_id: rec.adminUserId ?? null,
      action: rec.action,
      target_user_id: rec.targetUserId,
      details: rec.details ?? {},
      ip: rec.ip ?? null,
      user_agent: rec.userAgent ?? null,
    });
    if (error) {
      logger.error({ err: error.message, action: rec.action, targetUserId: rec.targetUserId }, "audit_insert_failed");
    }
  } catch (e) {
    logger.error({ err: String(e), action: rec.action }, "audit_insert_exception");
  }
}
