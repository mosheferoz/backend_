import "dotenv/config";
import { z } from "zod";

/**
 * Centralised, validated configuration. Parsed once at boot — the process
 * refuses to start on misconfiguration (fail-fast) so we never run with a
 * half-configured payment backend.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.string().optional(),

  BACKEND_BASE_URL: z.string().url(),
  APP_BASE_URL: z.string().url(),
  ALLOWED_ORIGINS: z.string().optional(),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_JWKS_URL: z.string().url().optional(),

  MESHULAM_BASE: z
    .string()
    .url()
    .default("https://sandbox.meshulam.co.il/api/light/server/1.0"),
  MESHULAM_USER_ID: z.string().min(1),
  MESHULAM_PAGE_CODE: z.string().min(1),
  MESHULAM_API_KEY: z.string().optional().default(""),

  GROW_NOTIFY_SECRET: z.string().min(8),
  CRON_SECRET: z.string().min(8),
  // 32-byte key (base64) for AES-256-GCM encryption of card tokens at rest.
  TOKEN_ENC_KEY: z.string().min(44),
  // TEMP tester bypass: when set, /api/redeem-code grants access without Grow.
  // Leave empty to disable the feature entirely.
  TESTER_CODE: z.string().optional().default(""),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("❌ Invalid environment configuration:");
  // eslint-disable-next-line no-console
  console.error(JSON.stringify(parsed.error.flatten().fieldErrors, null, 2));
  process.exit(1);
}

const env = parsed.data;
const stripSlash = (u: string) => u.replace(/\/+$/, "");

export const config = {
  nodeEnv: env.NODE_ENV,
  isProd: env.NODE_ENV === "production",
  isTest: env.NODE_ENV === "test",
  port: env.PORT,
  logLevel: env.LOG_LEVEL ?? (env.NODE_ENV === "production" ? "info" : "debug"),

  backendBaseUrl: stripSlash(env.BACKEND_BASE_URL),
  appBaseUrl: stripSlash(env.APP_BASE_URL),
  allowedOrigins: (env.ALLOWED_ORIGINS ?? env.APP_BASE_URL)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  supabase: {
    url: stripSlash(env.SUPABASE_URL),
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    jwksUrl:
      env.SUPABASE_JWKS_URL ??
      `${stripSlash(env.SUPABASE_URL)}/auth/v1/.well-known/jwks.json`,
  },

  meshulam: {
    base: stripSlash(env.MESHULAM_BASE),
    userId: env.MESHULAM_USER_ID,
    pageCode: env.MESHULAM_PAGE_CODE,
    apiKey: env.MESHULAM_API_KEY,
  },

  growNotifySecret: env.GROW_NOTIFY_SECRET,
  cronSecret: env.CRON_SECRET,
  tokenEncKey: env.TOKEN_ENC_KEY,
  testerCode: env.TESTER_CODE,
} as const;

export type AppConfig = typeof config;
