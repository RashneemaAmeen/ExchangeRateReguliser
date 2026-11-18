import { z } from 'zod';
import { AppError } from '../lib/errors.js';
import { fetchJson } from '../lib/http.js';
import { isIsoCurrency } from '../lib/currency.js';
import type { ExchangeRateProvider, ProviderInfo, ProviderSnapshot } from './types.js';

/**
 * fawazahmed0 "currency-api" – https://github.com/fawazahmed0/exchange-api
 * Free, no key, served as static JSON from the jsDelivr CDN, one snapshot per day,
 * with dated snapshots available (used for the history endpoint).
 * Community-maintained: suitable for testing/fallback, not as an authoritative source.
 */
const dateRe = /^\d{4}-\d{2}-\d{2}$/;

export class CurrencyApiProvider implements ExchangeRateProvider {
  readonly info: ProviderInfo = {
    id: 'currency-api',
    name: 'fawazahmed0 Currency API (community)',
    website: 'https://github.com/fawazahmed0/exchange-api',
    attribution: 'Data from fawazahmed0/exchange-api (community-maintained, CC0)',
    rateType: 'reference',
    rateLabel: 'Reference (mid-market)',
    rateClass: 'MID',
    updateFrequency: 'Once per day (not real-time)',
    supportsHistory: true,
    notes: 'Community-maintained aggregate of public sources. Use for testing or fallback only.',
  };

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  fetchLatest(base: string): Promise<ProviderSnapshot> {
    return this.fetchSnapshot(base, 'latest');
  }

  fetchHistorical(base: string, date: string): Promise<ProviderSnapshot> {
    if (!dateRe.test(date)) throw new AppError(400, 'VALIDATION_ERROR', `Invalid date "${date}".`);
    return this.fetchSnapshot(base, date);
  }

  private async fetchSnapshot(base: string, version: string): Promise<ProviderSnapshot> {
    const key = base.toLowerCase();
    const url = `${this.baseUrl}@${version}/v1/currencies/${key}.json`;
    const { status, body } = await fetchJson(url, this.timeoutMs, { allowErrorStatus: true, providerName: this.info.name });
    if (status === 404) {
      throw new AppError(
        version === 'latest' ? 400 : 404,
        version === 'latest' ? 'UNSUPPORTED_CURRENCY' : 'NOT_FOUND',
        version === 'latest'
          ? `${this.info.name} does not support base currency ${base}.`
          : `${this.info.name} has no snapshot for ${version}.`,
      );
    }
    if (status >= 400) {
      throw new AppError(502, 'UPSTREAM_HTTP_ERROR', `${this.info.name} returned HTTP ${status}.`);
    }

    const schema = z.object({
      date: z.string().regex(dateRe),
      [key]: z.record(z.string(), z.number()),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new AppError(502, 'UPSTREAM_INVALID_RESPONSE', `${this.info.name} returned data in an unexpected format.`);
    }
    const raw = parsed.data[key] as Record<string, number>;

    const quotes: Record<string, number> = {};
    for (const [code, value] of Object.entries(raw)) {
      const upper = code.toUpperCase();
      // Skip crypto/non-ISO codes and any non-positive or non-finite values.
      if (/^[a-z]{3}$/.test(code) && isIsoCurrency(upper) && Number.isFinite(value) && value > 0) {
        quotes[upper] = value;
      }
    }
    if (Object.keys(quotes).length === 0) {
      throw new AppError(502, 'UPSTREAM_INVALID_RESPONSE', `${this.info.name} returned no usable rates.`);
    }

    return {
      provider: this.info,
      base,
      quotes,
      effectiveDate: parsed.data.date as string,
      publishedAt: null,
      nextUpdateAt: null,
    };
  }
}
