import { Decimal, decimalFromProvider, toFixedString } from '../lib/decimal.js';
import { currencyName, minorUnits } from '../lib/currency.js';
import { AppError } from '../lib/errors.js';
import type { ProviderSnapshot } from '../providers/types.js';

/**
 * RATE DIRECTION – the single most important convention in this POC.
 *
 * Providers return quotes against a base:   quote[X] = units of X per 1 TARGET
 *   e.g. base AED: quote[USD] = 0.272294  ->  1 AED = 0.272294 USD
 *
 * ERP users want the foreign-currency rate:   rate[X] = units of TARGET per 1 X
 *   rate[USD] = 1 / 0.272294 = 3.67250  ->  1 USD = 3.6725 AED
 *
 * Cross rate X -> Y (both quoted against TARGET):
 *   1 X = rate[X] TARGET = rate[X] / rate[Y] Y = quote[Y] / quote[X] Y
 * We use the raw quotes (not rounded rates) so no precision is lost.
 */

export interface NormalisedRate {
  currencyCode: string;
  currencyName: string;
  /** Units of target per 1 unit of currencyCode (e.g. 1 USD = 3.6725 AED). */
  rate: string;
  /** Units of currencyCode per 1 unit of target, exactly as published by the provider. */
  inverseRate: string;
  /** Human-readable direction, e.g. "1 USD = 3.67250000 AED". */
  direction: string;
}

function quoteFor(snapshot: ProviderSnapshot, code: string): Decimal {
  if (code === snapshot.base) return new Decimal(1);
  const q = snapshot.quotes[code];
  if (q === undefined) {
    throw new AppError(404, 'UNSUPPORTED_CURRENCY', `${code} is not available from ${snapshot.provider.name}.`);
  }
  const d = decimalFromProvider(q);
  if (!d.isFinite() || d.lte(0)) {
    throw new AppError(502, 'UPSTREAM_INVALID_RESPONSE', `${snapshot.provider.name} returned an invalid rate for ${code}.`);
  }
  return d;
}

export function normaliseRate(snapshot: ProviderSnapshot, code: string, decimals: number): NormalisedRate {
  const q = quoteFor(snapshot, code);
  const rate = new Decimal(1).div(q);
  const rateStr = toFixedString(rate, decimals);
  return {
    currencyCode: code,
    currencyName: currencyName(code),
    rate: rateStr,
    inverseRate: q.toFixed(),
    direction: `1 ${code} = ${rateStr} ${snapshot.base}`,
  };
}

/**
 * Re-bases a rate onto another currency in the SAME snapshot (cross rate), e.g. for the Saudi branch table:
 *   rate = units of `base` per 1 `code` = quote[base] / quote[code]
 *   AED snapshot: quote[SAR] = 1.021103, quote[USD] = 0.272294  ->  1 USD = 3.75 SAR
 * When base === snapshot.base this equals normaliseRate().
 */
export function rebaseRate(snapshot: ProviderSnapshot, code: string, base: string, decimals: number): NormalisedRate {
  const qCode = quoteFor(snapshot, code);
  const qBase = quoteFor(snapshot, base);
  const rate = qBase.div(qCode);
  const rateStr = toFixedString(rate, decimals);
  return {
    currencyCode: code,
    currencyName: currencyName(code),
    rate: rateStr,
    inverseRate: toFixedString(qCode.div(qBase), decimals),
    direction: `1 ${code} = ${rateStr} ${base}`,
  };
}

export function supportedCodes(snapshot: ProviderSnapshot): string[] {
  return Object.keys(snapshot.quotes)
    .filter((c) => c !== snapshot.base)
    .sort();
}

export interface ConversionResult {
  from: string;
  to: string;
  amount: string;
  result: string;
  /** 1 from = X to */
  rate: string;
  /** 1 to = X from */
  inverseRate: string;
  via: string;
  resultDecimalPlaces: number;
}

export function convert(snapshot: ProviderSnapshot, from: string, to: string, amount: Decimal, decimals: number): ConversionResult {
  const qFrom = quoteFor(snapshot, from);
  const qTo = quoteFor(snapshot, to);
  const crossRate = qTo.div(qFrom); // units of `to` per 1 `from`
  const dp = minorUnits(to);
  return {
    from,
    to,
    amount: amount.toFixed(),
    result: toFixedString(amount.mul(crossRate), dp),
    rate: toFixedString(crossRate, decimals),
    inverseRate: toFixedString(new Decimal(1).div(crossRate), decimals),
    via: snapshot.base,
    resultDecimalPlaces: dp,
  };
}
