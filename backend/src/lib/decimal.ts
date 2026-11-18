import { Decimal as DecimalLib } from 'decimal.js';

/**
 * Isolated Decimal constructor for all financial maths.
 * 34 significant digits (IEEE 754 decimal128) and HALF_UP rounding (0.5 rounds away
 * from zero), which is what finance users usually expect on screen.
 * Never use JS `number` arithmetic on rates or amounts.
 */
export const Decimal = DecimalLib.clone({ precision: 34, rounding: DecimalLib.ROUND_HALF_UP });
export type Decimal = InstanceType<typeof Decimal>;

/** Strict decimal string: no exponent, no sign, optional fraction. */
const DECIMAL_RE = /^\d{1,15}(\.\d{1,12})?$/;

export function parsePositiveDecimal(value: unknown): Decimal | null {
  const s = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!DECIMAL_RE.test(s)) return null;
  const d = new Decimal(s);
  return d.gt(0) ? d : null;
}

/**
 * Convert a JSON number from a provider to Decimal without binary noise.
 * String(number) yields the shortest round-trip representation, i.e. exactly the
 * digits the provider sent (e.g. 0.272294 -> "0.272294").
 */
export function decimalFromProvider(n: number): Decimal {
  return new Decimal(String(n));
}

/** Fixed-point string, never exponential notation. */
export function toFixedString(d: Decimal, dp: number): string {
  return d.toDecimalPlaces(dp, Decimal.ROUND_HALF_UP).toFixed(dp);
}
