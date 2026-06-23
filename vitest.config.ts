import { defineConfig } from "vitest/config";

// Minimal env so config.ts (fail-fast validation) loads cleanly under test.
export default defineConfig({
  test: {
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      BACKEND_BASE_URL: "http://localhost:8080",
      APP_BASE_URL: "http://localhost:5173",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
      MESHULAM_USER_ID: "test-user",
      MESHULAM_PAGE_CODE: "test-page",
      GROW_NOTIFY_SECRET: "test-notify-secret",
      CRON_SECRET: "test-cron-secret",
      // base64 of 32 zero-bytes (valid 32-byte key for tests)
      TOKEN_ENC_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    },
  },
});
