import { AppError } from './errors.js';

/** ISO 4217 codes known to the runtime's ICU data (used to filter out crypto / non-ISO codes). */
const ISO_CODES: ReadonlySet<string> = new Set(Intl.supportedValuesOf('currency'));

const displayNames = new Intl.DisplayNames(['en'], { type: 'currency' });

export function isIsoCurrency(code: string): boolean {
  return ISO_CODES.has(code);
}

export function currencyName(code: string): string {
  try {
    return displayNames.of(code) ?? code;
  } catch {
    return code;
  }
}

/** Number of minor units (e.g. USD 2, JPY 0, KWD 3) for rounding converted amounts. */
export function minorUnits(code: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** Normalise and validate a currency code from user input. Throws 400 on bad format. */
export function normaliseCurrencyCode(input: unknown, field = 'currency'): string {
  const code = typeof input === 'string' ? input.trim().toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new AppError(400, 'INVALID_CURRENCY', `"${String(input ?? '')}" is not a valid 3-letter ISO 4217 currency code (${field}).`);
  }
  if (!isIsoCurrency(code)) {
    throw new AppError(400, 'INVALID_CURRENCY', `"${code}" is not a recognised ISO 4217 currency code (${field}).`);
  }
  return code;
}

/** Parse "USD,EUR, gbp" into validated, de-duplicated codes. */
export function parseCurrencyList(input: unknown, field = 'currencies'): string[] {
  if (input === undefined || input === null || input === '') return [];
  const raw = Array.isArray(input) ? input.join(',') : String(input);
  const codes = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((c) => normaliseCurrencyCode(c, field));
  if (codes.length > 200) throw new AppError(400, 'VALIDATION_ERROR', 'Too many currencies requested (max 200).');
  return [...new Set(codes)];
}
