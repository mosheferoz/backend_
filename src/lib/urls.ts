import { config } from "../config.js";

/**
 * Grow can't send custom headers on its server-to-server notify, so the gate
 * secret travels in the query string. It's defense-in-depth only — every
 * webhook is independently re-verified server-to-server (getTransactionInfo).
 */
export function growNotifyUrl(): string {
  return `${config.backendBaseUrl}/webhook?secret=${encodeURIComponent(config.growNotifySecret)}`;
}

export function growInvoiceNotifyUrl(): string {
  return `${config.backendBaseUrl}/webhook/invoice?secret=${encodeURIComponent(config.growNotifySecret)}`;
}

export function successUrl(plan: string, mode: string): string {
  const p = encodeURIComponent(plan);
  const m = encodeURIComponent(mode);
  return `${config.appBaseUrl}/checkout/success?plan=${p}&mode=${m}`;
}

export function cancelUrl(): string {
  return `${config.appBaseUrl}/dashboard?checkout=canceled`;
}
