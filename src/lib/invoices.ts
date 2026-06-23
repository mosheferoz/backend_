/**
 * Grow issues the tax invoice/receipt automatically (we pass invoiceNotifyUrl +
 * productData on every charge). This helper extracts the invoice reference/URL
 * from Grow's invoice notify payload so we can store it on the payment row.
 *
 * NOTE: the exact field names of the invoice webhook are not in grow.md — this
 * is best-effort across the common variants and must be confirmed in sandbox
 * (inspect the first real invoice notify, then tighten these keys).
 */
export interface InvoiceRef {
  ref?: string;
  url?: string;
}

export function extractInvoiceRef(payload: Record<string, unknown> | null | undefined): InvoiceRef {
  const root = (payload ?? {}) as Record<string, unknown>;
  const data =
    root.data && typeof root.data === "object"
      ? (root.data as Record<string, unknown>)
      : root;

  const pick = (keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = data[k];
      if (v !== undefined && v !== null && v !== "") return String(v);
    }
    return undefined;
  };

  return {
    ref: pick(["docNumber", "documentNumber", "invoiceNumber", "invoiceId", "docId"]),
    url: pick(["docUrl", "documentUrl", "invoiceUrl", "originalUrl", "url"]),
  };
}
