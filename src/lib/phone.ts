/** Normalize an Israeli phone to local digits, e.g. "+972 50-123-4567" -> "0501234567". */
export function normalizeILPhone(raw: string | null | undefined): string {
  let d = (raw ?? "").replace(/\D/g, "");
  if (d.startsWith("972")) d = "0" + d.slice(3);
  return d;
}

/** Valid Israeli mobile number: 05X followed by 7 digits (10 digits total). */
export function isValidILMobile(raw: string | null | undefined): boolean {
  return /^05\d{8}$/.test(normalizeILPhone(raw));
}
