import { createClient } from "@supabase/supabase-js";
import { config } from "../config.js";

/**
 * Service-role Supabase client — used ONLY by the backend to write billing
 * state. Never exposed to the browser. (For extra defense-in-depth this can be
 * swapped for a dedicated `billing_writer` Postgres role granted only on the
 * billing tables.)
 */
export const supabaseAdmin = createClient(
  config.supabase.url,
  config.supabase.serviceRoleKey,
  {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-application-name": "controlclick-billing" } },
  },
);
