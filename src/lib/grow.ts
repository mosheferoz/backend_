import { config } from "../config.js";
import { logger } from "./logger.js";

/**
 * Grow / Meshulam "light server" API client.
 *
 * References: project grow.md + Grow support guidance.
 * Conventions:
 *   - POST application/x-www-form-urlencoded (confirmed working against sandbox).
 *   - Responses are JSON: { status: "1" } = success, { status: "0", err:{id,message} } = error.
 *   - Credit-card ONLY (no wallets) on the token page.
 *   - notify + approveTransaction happen ONLY on the first transaction; token
 *     charges (renewals) are synchronous — the result is in this call's response.
 */

export const ChargeType = {
  /** Charge now + (with saveCardToken) store the token. */
  SUBSCRIBE: 1,
  /** J5 pre-authorization (₪1 card validation). */
  J5_TRIAL_AUTH: 2,
  /** Save the token only, no charge — used for the free trial. */
  SAVE_TOKEN_ONLY: 3,
} as const;

export const PaymentType = {
  DIRECT_DEBIT: 1,
  /** Regular one-time charge — what we use for token renewals. */
  REGULAR: 2,
  INSTALLMENTS: 4,
} as const;

export const TransactionType = {
  CREDIT_CARD: 1,
  BIT: 6,
  APPLE_PAY: 13,
  GOOGLE_PAY: 14,
  BANK_TRANSFER: 15,
  PAYBOX: 5,
} as const;

/** Grow returns this error id when a transactionUniqueIdentifier is reused. */
export const GROW_DUPLICATE_UNIQUE_ID_ERROR = 1010;

export interface GrowResult<T = Record<string, unknown>> {
  status: number | string;
  err?: { id?: number; message?: string };
  data?: T;
}

export function isGrowSuccess(r: GrowResult<unknown> | null | undefined): boolean {
  return String(r?.status) === "1";
}

export function isDuplicateUniqueId(r: GrowResult<unknown> | null | undefined): boolean {
  return !isGrowSuccess(r) && Number(r?.err?.id) === GROW_DUPLICATE_UNIQUE_ID_ERROR;
}

/**
 * Best-effort interpretation of a getTokenTransactionsByExternalIdentifiers
 * result: does it show a PAID transaction? Used to resolve uncertain charges
 * before retrying (avoids double charge). The exact payload shape isn't in
 * grow.md — confirm against a real sandbox query and tighten if needed.
 */
export function tokenQueryIndicatesPaid(q: GrowResult<unknown> | null | undefined): boolean {
  if (!isGrowSuccess(q)) return false;
  const data = q?.data as unknown;
  const txns: Array<Record<string, unknown>> = Array.isArray(data)
    ? (data as Array<Record<string, unknown>>)
    : data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).transactions)
      ? ((data as Record<string, unknown>).transactions as Array<Record<string, unknown>>)
      : data && typeof data === "object"
        ? [data as Record<string, unknown>]
        : [];
  return txns.some((t) => {
    const s = String(t?.statusCode ?? t?.status ?? "").toLowerCase();
    return s === "1" || s === "000" || s === "approved" || Boolean(t?.asmachta);
  });
}

type FormValue = string | number | boolean | undefined | null;

async function postForm<T = Record<string, unknown>>(
  path: string,
  fields: Record<string, FormValue>,
): Promise<GrowResult<T>> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === "") continue;
    body.set(k, typeof v === "boolean" ? (v ? "1" : "0") : String(v));
  }

  let res: Response;
  try {
    res = await fetch(`${config.meshulam.base}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (e) {
    logger.error({ err: e, path }, "grow_network_error");
    return { status: 0, err: { message: "network_error" } };
  }

  const json = (await res.json().catch(() => null)) as GrowResult<T> | null;
  if (!json) return { status: 0, err: { message: "invalid_json" } };
  return json;
}

const auth = () => ({
  userId: config.meshulam.userId,
  pageCode: config.meshulam.pageCode,
  apiKey: config.meshulam.apiKey || undefined,
});

// ---------------------------------------------------------------------------

export interface CreatePaymentProcessParams {
  chargeType: number;
  /** Amount in shekels (verify shekels-vs-agorot against sandbox before prod). */
  sum: number;
  description: string;
  fullName: string;
  phone: string;
  email?: string;
  successUrl: string;
  cancelUrl: string;
  notifyUrl: string;
  invoiceNotifyUrl?: string;
  /** Defaults to true — we always want the token for renewals. */
  saveToken?: boolean;
  cField1?: string; // userId
  cField2?: string; // plan
  cField3?: string; // mode (subscribe|trial)
  invoiceName?: string;
  invoiceLicenseNumber?: string;
}

export interface PaymentProcessData {
  url: string;
  authCode?: string;
  processId: number;
  processToken: string;
}

/** Create a hosted credit-card payment form (and save the card token). */
async function createPaymentProcess(p: CreatePaymentProcessParams) {
  return postForm<PaymentProcessData>("createPaymentProcess", {
    ...auth(),
    chargeType: p.chargeType,
    sum: p.sum,
    description: p.description,
    saveCardToken: p.saveToken === false ? 0 : 1,
    successUrl: p.successUrl,
    cancelUrl: p.cancelUrl,
    notifyUrl: p.notifyUrl,
    invoiceNotifyUrl: p.invoiceNotifyUrl,
    "pageField[fullName]": p.fullName,
    "pageField[phone]": p.phone,
    "pageField[email]": p.email,
    "pageField[invoiceName]": p.invoiceName,
    "pageField[invoiceLicenseNumber]": p.invoiceLicenseNumber,
    // credit card ONLY — no wallets (Bit / Apple Pay / Google Pay / PayBox / bank transfer).
    "transactionTypes[0]": TransactionType.CREDIT_CARD,
    // invoice line item so Grow issues a proper tax invoice (price must equal sum -> err 617).
    "productData[0][itemDescription]": p.description,
    "productData[0][quantity]": 1,
    "productData[0][price]": p.sum,
    cField1: p.cField1,
    cField2: p.cField2,
    cField3: p.cField3,
  });
}

// ---------------------------------------------------------------------------

export interface ChargeTokenParams {
  cardToken: string;
  sum: number;
  description: string;
  fullName: string;
  phone: string;
  email?: string;
  /** Numeric, unique per ATTEMPT. Reuse -> Grow error 1010 (even after a failure). */
  transactionUniqueIdentifier: number | string;
  /** Numeric, NOT unique — for grouping/investigation. */
  transactionGroupIdentifier?: number | string;
  invoiceNotifyUrl?: string;
  cField1?: string;
  cField2?: string;
  cField3?: string;
}

export interface TokenChargeData {
  transactionId?: number;
  transactionToken?: string;
  asmachta?: string;
  cardSuffix?: string;
  cardBrand?: string;
  [k: string]: unknown;
}

/** Charge a saved card token (renewal). Synchronous — no webhook is sent. */
async function createTransactionWithToken(p: ChargeTokenParams) {
  return postForm<TokenChargeData>("createTransactionWithToken", {
    ...auth(),
    cardToken: p.cardToken,
    sum: p.sum,
    description: p.description,
    paymentType: PaymentType.REGULAR,
    paymentNum: 1,
    "pageField[fullName]": p.fullName,
    "pageField[phone]": p.phone,
    "pageField[email]": p.email,
    transactionUniqueIdentifier: p.transactionUniqueIdentifier,
    transactionGroupIdentifier: p.transactionGroupIdentifier,
    invoiceNotifyUrl: p.invoiceNotifyUrl,
    "productData[0][itemDescription]": p.description,
    "productData[0][quantity]": 1,
    "productData[0][price]": p.sum,
    cField1: p.cField1,
    cField2: p.cField2,
    cField3: p.cField3,
  });
}

// ---------------------------------------------------------------------------

/** Server-to-server verification of a transaction (never trust the webhook). */
async function getTransactionInfo(transactionId: string | number, transactionToken: string) {
  return postForm("getTransactionInfo", {
    pageCode: config.meshulam.pageCode,
    apiKey: config.meshulam.apiKey || undefined,
    transactionId,
    transactionToken,
  });
}

async function getPaymentProcessInfo(processId: string | number, processToken: string) {
  return postForm("getPaymentProcessInfo", {
    pageCode: config.meshulam.pageCode,
    apiKey: config.meshulam.apiKey || undefined,
    processId,
    processToken,
  });
}

/**
 * Query token transactions by external identifier — used to resolve an
 * uncertain charge (timeout) before retrying. Send EXACTLY ONE identifier.
 */
async function getTokenTransactionsByExternalIdentifiers(opts: {
  cardToken: string;
  transactionUniqueIdentifier?: number | string;
  transactionGroupIdentifier?: number | string;
}) {
  const hasUnique = opts.transactionUniqueIdentifier != null;
  const hasGroup = opts.transactionGroupIdentifier != null;
  if (hasUnique === hasGroup) {
    throw new Error("provide exactly one of transactionUniqueIdentifier / transactionGroupIdentifier");
  }
  return postForm("getTokenTransactionsByExternalIdentifiers/", {
    userId: config.meshulam.userId,
    cardToken: opts.cardToken,
    transactionUniqueIdentifier: opts.transactionUniqueIdentifier,
    transactionGroupIdentifier: opts.transactionGroupIdentifier,
  });
}

/**
 * Approve the FIRST transaction (required, else Grow re-sends the notify up to
 * 5x and the charge isn't finalized). NEVER call for J4/J5, save-token-only, or
 * token renewals. Forwards the webhook's fields back to Grow.
 */
async function approveTransaction(webhookData: Record<string, unknown>) {
  const fields: Record<string, FormValue> = { ...auth() };
  for (const [k, v] of Object.entries(webhookData)) {
    if (v !== null && v !== undefined && typeof v !== "object") {
      fields[k] = v as FormValue;
    }
  }
  return postForm("approveTransaction", fields);
}

async function refundTransaction(p: {
  transactionId: string | number;
  transactionToken: string;
  refundSum: number;
  stopDirectDebit?: boolean;
}) {
  return postForm("refundTransaction", {
    ...auth(),
    transactionId: p.transactionId,
    transactionToken: p.transactionToken,
    refundSum: p.refundSum,
    stopDirectDebit: p.stopDirectDebit ? 1 : undefined,
  });
}

export const grow = {
  createPaymentProcess,
  createTransactionWithToken,
  getTransactionInfo,
  getPaymentProcessInfo,
  getTokenTransactionsByExternalIdentifiers,
  approveTransaction,
  refundTransaction,
};
