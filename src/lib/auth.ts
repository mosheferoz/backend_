import type { Context, Next } from "hono";
import { supabaseAdmin } from "./supabaseAdmin.js";

export interface AuthedUser {
  id: string;
  email?: string;
}

/** Hono environment with the authenticated user attached by requireAuth. */
export type AppEnv = { Variables: { user: AuthedUser } };

/**
 * Verify the caller's Supabase access token. We validate via the Auth server
 * (works regardless of the project's signing algorithm) and attach the user.
 */
export async function requireAuth(c: Context<AppEnv>, next: Next) {
  const authz = c.req.header("Authorization") ?? "";
  const token = authz.startsWith("Bearer ") ? authz.slice(7).trim() : "";
  if (!token) return c.json({ ok: false, error: "unauthorized" }, 401);

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }

  c.set("user", { id: data.user.id, email: data.user.email ?? undefined });
  await next();
}
