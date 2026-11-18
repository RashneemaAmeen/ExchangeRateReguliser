import { z } from 'zod';
import { isIsoCurrency } from '../lib/currency.js';
import { AppError } from '../lib/errors.js';
import { fetchJson } from '../lib/http.js';
import type { ExchangeRateProvider, ProviderInfo, ProviderSnapshot } from './types.js';

/**
 * currencyapi.com (v3) – https://currencyapi.com/docs/latest
 *   GET {base}/latest?base_currency=AED          header  apikey: <key>
 *   GET {base}/historical?date=YYYY-MM-DD&base_currency=AED
 * Response: { meta: { last_updated_at, base_currency? }, data: { USD: { code, value } } }
 *   value = units of the currency per 1 base_currency (same direction as our ProviderSnapshot.quotes).
 *
 * The API key is read from backend env (CURRENCYAPI_COM_API_KEY) and sent only as a request header
 * from the server – it is never logged, put in URLs, or sent to the browser.
 */
const dateRe = /^\d{4}-\d{2}-\d{2}$/;

const successSchema = z.object({
  meta: z.object({
    last_updated_at: z.string().min(10),
    base_currency: z.string().optional(),
  }),
  data: z.record(z.string(), z.object({ code: z.string(), value: z.number() })),
});

const errorSchema = z.object({ message: z.string().optional() }).passthrough();

export class CurrencyApiComProvider implements ExchangeRateProvider {
  readonly info: ProviderInfo = {
    id: 'currencyapi-com',
    name: 'currencyapi.com',
    website: 'https://currencyapi.com',
    attribution: 'Exchange rates provided by currencyapi.com',
    rateType: 'reference',
    rateLabel: 'Reference (mid-market)',
    rateClass: 'MID',
    updateFrequency: 'Daily on the free plan; hourly or faster on paid plans (not real-time)',
    supportsHistory: true,
    // Each historical day costs one request; the 30-day chart would burn the free quota.
    maxHistoryDays: 0,
    notes:
      'Commercial aggregator ("several financial data providers and international banks"). Reference rates – not a central-bank fixing and not a bank buy/sell rate. Free plan: 300 requests/month, private use only.',
  };

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | null,
    private readonly timeoutMs: number,
  ) {}

  fetchLatest(base: string): Promise<ProviderSnapshot> {
    return this.request('latest', base, {});
  }

  fetchHistorical(base: string, date: string): Promise<ProviderSnapshot> {
    if (!dateRe.test(date)) throw new AppError(400, 'VALIDATION_ERROR', `Invalid date "${date}".`);
    return this.request('historical', base, { date });
  }

  private async request(endpoint: 'latest' | 'historical', base: string, extra: Record<string, string>): Promise<ProviderSnapshot> {
    if (!this.apiKey) {
      throw new AppError(
        503,
        'PROVIDER_NOT_CONFIGURED',
        'currencyapi.com is not configured. Add CURRENCYAPI_COM_API_KEY to backend/.env and restart the backend.',
      );
    }
    const params = new URLSearchParams({ base_currency: base, ...extra });
    const url = `${this.baseUrl}/${endpoint}?${params}`;
    const { status, body } = await fetchJson(url, this.timeoutMs, {
      allowErrorStatus: true,
      providerName: this.info.name,
      headers: { apikey: this.apiKey },
    });

    if (status >= 400) throw this.mapError(status, body, base);

    const parsed = successSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError(502, 'UPSTREAM_INVALID_RESPONSE', `${this.info.name} returned data in an unexpected format.`, {
        issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    const { meta, data } = parsed.data;
    if (meta.base_currency && meta.base_currency !== base) {
      throw new AppError(502, 'UPSTREAM_INVALID_RESPONSE', `${this.info.name} returned base ${meta.base_currency}, expected ${base}.`);
    }

    const quotes: Record<string, number> = {};
    for (const [code, entry] of Object.entries(data)) {
      // Only positive, finite ISO currencies (skips crypto and metals such as BTC or XAU).
      if (isIsoCurrency(code) && Number.isFinite(entry.value) && entry.value > 0) quotes[code] = entry.value;
    }
    if (quotes[base] === undefined) quotes[base] = 1;

    const published = new Date(meta.last_updated_at);
    if (Number.isNaN(published.getTime())) {
      throw new AppError(502, 'UPSTREAM_INVALID_RESPONSE', `${this.info.name} returned an invalid last_updated_at.`);
    }
    return {
      provider: this.info,
      base,
      quotes,
      effectiveDate: extra.date ?? published.toISOString().slice(0, 10),
      publishedAt: published.toISOString(),
      nextUpdateAt: null,
    };
  }

  private mapError(status: number, body: unknown, base: string): AppError {
    const msg = errorSchema.safeParse(body).success ? (body as { message?: string }).message : undefined;
    const detail = msg ? ` (${msg})` : '';
    switch (status) {
      case 401:
        return new AppError(502, 'PROVIDER_AUTH_FAILED', `currencyapi.com rejected the API key${detail}. Check CURRENCYAPI_COM_API_KEY in backend/.env.`);
      case 403:
        return new AppError(502, 'PROVIDER_PLAN_LIMIT', `currencyapi.com: this request is not allowed on the current plan${detail}.`);
      case 422:
        if (/currenc/i.test(msg ?? '')) {
          return new AppError(400, 'UNSUPPORTED_CURRENCY', `currencyapi.com does not accept base currency ${base}${detail}.`);
        }
        return new AppError(502, 'UPSTREAM_HTTP_ERROR', `currencyapi.com rejected the request${detail}.`);
      case 429:
        return new AppError(
          429,
          'PROVIDER_QUOTA_EXCEEDED',
          `currencyapi.com request limit reached${detail}. The free plan allows 300 requests per month; cached rates are used where available.`,
        );
      default:
        return new AppError(502, 'UPSTREAM_HTTP_ERROR', `currencyapi.com returned HTTP ${status}${detail}.`);
    }
  }
}
