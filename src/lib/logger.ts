import pino from "pino";
import { config } from "../config.js";

/**
 * Structured logger. In dev we pretty-print; in prod we emit JSON for the
 * platform's log pipeline. Sensitive fields are redacted everywhere — a card
 * token or secret must never reach the logs.
 */
export const logger = pino({
  level: config.logLevel,
  ...(config.isProd
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss" },
        },
      }),
  redact: {
    paths: [
      "*.card_token",
      "*.cardToken",
      "*.token",
      "*.apiKey",
      "*.api_key",
      "*.password",
      "*.service_role_key",
      "*.email",
      "*.phone",
      "*.payerEmail",
      "*.payerPhone",
      "req.headers.authorization",
      "req.headers['x-grow-secret']",
      "req.headers['x-cron-secret']",
    ],
    censor: "[redacted]",
  },
});

export type Logger = typeof logger;
