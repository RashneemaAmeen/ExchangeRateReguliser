import { z } from 'zod';
import { AppError } from '../lib/errors.js';
import { fetchJson } from '../lib/http.js';
import { isIsoCurrency } from '../lib/currency.js';
import type { ExchangeRateProvider, ProviderInfo, ProviderSnapshot } from './types.js';

/**
 * ExchangeRate-API "Open Access" endpoint – https://www.exchangerate-api.com/docs/free
 * Free, no API key, updates once per day, includes AED/SAR/INR/CNY.
 * Terms require attribution and discourage requesting more than about once per hour.
 */
const successSchema = z.object({
  result: z.literal('success'),
  base_code: z.string().regex(/^[A-Z]{3}$/),
  time_last_update_unix: z.number().int().positive(),
  time_next_update_unix: z.number().int().positive().optional(),
  rates: z.record(z.string(), z.number().positive().finite()),
});

const errorSchema = z.object({
  result: z.literal('error'),
  'error-type': z.string().optional(),
});

export class OpenErApiProvider implements ExchangeRateProvider {
  readonly info: ProviderInfo = {
    id: 'open-er-api',
    name: 'ExchangeRate-API (Open Access)',
    website: 'https://www.exchangerate-api.com',
    attribution: 'Rates By Exchange Rate API (https://www.exchangerate-api.com)',
    rateType: 'reference',
    rateLabel: 'Reference (mid-market)',
    rateClass: 'MID',
    updateFrequency: 'Once per day (not real-time)',
    supportsHistory: false,
    notes:
      'Aggregated mid-market reference rates from multiple sources. Not a central-bank fixing and not a bank buy/sell rate.',
  };

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  async fetchLatest(base: string): Promise<ProviderSnapshot> {
    const url = `${this.baseUrl}/latest/${encodeURIComponent(base)}`;
    const { body } = await fetchJson(url, this.timeoutMs, { allowErrorStatus: true, providerName: this.info.name });

    const err = errorSchema.safeParse(body);
    if (err.success) {
      const type = err.data['error-type'] ?? 'unknown';
      if (type === 'unsupported-code') {
        throw new AppError(400, 'UNSUPPORTED_CURRENCY', `${this.info.name} does not support base currency ${base}.`);
      }
      throw new AppError(502, 'UPSTREAM_HTTP_ERROR', `${this.info.name} returned an error: ${type}.`);
    }

    const parsed = successSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError(502, 'UPSTREAM_INVALID_RESPONSE', `${this.info.name} returned data in an unexpected format.`, {
        issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    const data = parsed.data;
    if (data.base_code !== base) {
      throw new AppError(502, 'UPSTREAM_INVALID_RESPONSE', `${this.info.name} returned base ${data.base_code}, expected ${base}.`);
    }

    const quotes: Record<string, number> = {};
    for (const [code, value] of Object.entries(data.rates)) {
      if (isIsoCurrency(code)) quotes[code] = value;
    }

    const published = new Date(data.time_last_update_unix * 1000);
    return {
      provider: this.info,
      base,
      quotes,
      effectiveDate: published.toISOString().slice(0, 10),
      publishedAt: published.toISOString(),
      nextUpdateAt: data.time_next_update_unix ? new Date(data.time_next_update_unix * 1000).toISOString() : null,
    };
  }
}
