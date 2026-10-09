/**
 * One stored form for a phone number.
 * Indian mobiles become +91XXXXXXXXXX.
 * A number that already has another country code stays in E.164.
 */
export function canonicalPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D/g, "");
  const plus = trimmed.startsWith("+");
  if (plus && /^91[6-9]\d{9}$/.test(digits)) return `+${digits}`;
  if (/^0[6-9]\d{9}$/.test(digits)) return `+91${digits.slice(1)}`;
  if (/^[6-9]\d{9}$/.test(digits)) return `+91${digits}`;
  if (/^91[6-9]\d{9}$/.test(digits)) return `+${digits}`;
  if (plus && /^[1-9]\d{7,14}$/.test(digits)) return `+${digits}`;
  return null;
}
