import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { isIsoCurrency } from '../lib/currency.js';
import { AppError } from '../lib/errors.js';
import { fetchJson } from '../lib/http.js';
import type { ExchangeRateProvider, ProviderInfo, ProviderSnapshot } from './types.js';

/**
 * OANDA Exchange Rates API (business and financial data – NOT the OANDA forex trading API).
 * Contract taken from OANDA's own published client (github.com/oanda/nodejs-exchange-rates, v1 endpoints):
 *
 *   GET {base}/rates/{BASE}.json?quote=USD&quote=EUR&fields=midpoint&decimal_places=10[&date=YYYY-MM-DD]
 *   header  Authorization: Bearer <api key>
 *   200     { quotes: { USD: { midpoint: "0.27229", date: "…" } }, meta: { effective_params: { date } }, base_currency }
 *   errors  non-200 with { code, message }
 *
 * quotes[X] = units of X per 1 BASE – the same direction as every other provider in this app.
 * `fields=midpoint` returns the daily average midpoint; `fields=averages` returns the daily average bid and ask.
 *
 * The API key is read from backend env (OANDA_API_KEY) and sent only as a request header from the server. It is never
 * logged, put in a URL, returned to the browser, or included in an error message.
 */

export type OandaRateType = 'midpoint' | 'bid' | 'ask';

export const OANDA_RATE_TYPES: Record<
  OandaRateType,
  { label: string; description: string; fields: 'midpoint' | 'averages'; field: 'midpoint' | 'bid' | 'ask'; rateClass: 'MID' | 'BID' | 'ASK' }
> = {
  midpoint: {
    label: 'Daily average midpoint',
    description: "OANDA's daily average midpoint rate – comparable with the other providers' mid-market rates.",
    fields: 'midpoint',
    field: 'midpoint',
    rateClass: 'MID',
  },
  bid: {
    label: 'Daily average bid',
    description: "OANDA's daily average bid. One side of the spread: not comparable with a mid-market rate.",
    fields: 'averages',
    field: 'bid',
    rateClass: 'BID',
  },
  ask: {
    label: 'Daily average ask',
    description: "OANDA's daily average ask. One side of the spread: not comparable with a mid-market rate.",
    fields: 'averages',
    field: 'ask',
    rateClass: 'ASK',
  },
};

export const isOandaRateType = (v: unknown): v is OandaRateType => typeof v === 'string' && v in OANDA_RATE_TYPES;

const dateRe = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL_PLACES = 10;

const quoteSchema = z
  .object({
    date: z.string().optional(),
    midpoint: z.union([z.string(), z.number()]).optional(),
    bid: z.union([z.string(), z.number()]).optional(),
    ask: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

const successSchema = z.object({
  quotes: z.record(z.string(), quoteSchema),
  meta: z
    .object({
      effective_params: z.object({ date: z.string().optional() }).passthrough().optional(),
      skipped_currencies: z.array(z.string()).optional(),
    })
    .passthrough()
    .optional(),
  base_currency: z.string().optional(),
});

const errorSchema = z.object({ code: z.union([z.number(), z.string()]).optional(), message: z.string().optional() }).passthrough();

export interface OandaOptions {
  baseUrl: string;
  apiKey: string | null;
  timeoutMs: number;
  rateType: OandaRateType;
  /** Quote currencies to request per call (OANDA counts quotes), or 'all'. */
  quoteCurrencies: string[] | 'all';
  /** Longest multi-day history chart allowed (each day is a request); 0 turns it off. */
  historyMaxDays: number;
  caCertFile: string | null;
}

/** "2014-01-01T21:00:00+0000" -> ISO with a colon in the offset, which every JS engine parses. */
const parseOandaDate = (s: string): Date => new Date(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));

export class OandaProvider implements ExchangeRateProvider {
  readonly info: ProviderInfo;
  private caPem: string[] | null | undefined;
  /** Past days never change, so history snapshots are kept for the life of the process (saves quota). */
  private readonly historyCache = new Map<string, Promise<ProviderSnapshot>>();

  constructor(private readonly opts: OandaOptions) {
    const t = OANDA_RATE_TYPES[opts.rateType];
    this.info = {
      id: 'oanda',
      name: 'OANDA',
      website: 'https://www.oanda.com/foreign-exchange-data-services/en/exchange-rates-api/',
      attribution: 'Exchange rates provided by OANDA',
      rateType: 'reference',
      rateLabel: `${t.label} (OANDA)`,
      rateClass: t.rateClass,
      updateFrequency: 'Daily average rate, published once per day (not real-time)',
      supportsHistory: true,
      maxHistoryDays: opts.historyMaxDays,
      notes:
        'Commercial FX data provider. This is a daily average rate for business and financial use, not a live trading price and not a bank buy/sell rate. A paid or trial subscription is required.',
    };
  }

  fetchLatest(base: string): Promise<ProviderSnapshot> {
    return this.request(base, null);
  }

  fetchHistorical(base: string, date: string): Promise<ProviderSnapshot> {
    if (!dateRe.test(date)) throw new AppError(400, 'VALIDATION_ERROR', `Invalid date "${date}".`);
    const key = `${base}|${date}`;
    let p = this.historyCache.get(key);
    if (!p) {
      p = this.request(base, date);
      this.historyCache.set(key, p);
      p.catch(() => this.historyCache.delete(key));
    }
    return p;
  }

  /** Extra trusted CA from OANDA_CA_CERT_FILE (company firewall). Read once; problems are reported per request. */
  private extraCa(): string[] | undefined {
    const file = this.opts.caCertFile;
    if (!file) return undefined;
    if (this.caPem === undefined) {
      try {
        const pem = readFileSync(file, 'utf8');
        if (!pem.includes('BEGIN CERTIFICATE')) throw new Error('the file does not contain a PEM certificate');
        this.caPem = [pem];
      } catch (e) {
        throw new AppError(
          503,
          'PROVIDER_NOT_CONFIGURED',
          `OANDA_CA_CERT_FILE could not be used (${(e as NodeJS.ErrnoException).code === 'ENOENT' ? 'file not found' : (e as Error).message}). Check the path in backend/.env.`,
        );
      }
    }
    return this.caPem ?? undefined;
  }

  private async request(base: string, date: string | null): Promise<ProviderSnapshot> {
    const { apiKey, rateType } = this.opts;
    if (!apiKey) {
      throw new AppError(503, 'PROVIDER_NOT_CONFIGURED', 'OANDA is not configured. Add OANDA_API_KEY to backend/.env and restart the backend.');
    }
    const t = OANDA_RATE_TYPES[rateType];
    const params = new URLSearchParams();
    if (this.opts.quoteCurrencies !== 'all') {
      for (const q of this.opts.quoteCurrencies) if (q !== base) params.append('quote', q);
    }
    params.set('fields', t.fields);
    params.set('decimal_places', String(DECIMAL_PLACES));
    if (date) params.set('date', date);

    const { status, body } = await fetchJson(`${this.opts.baseUrl}/rates/${encodeURIComponent(base)}.json?${params}`, this.opts.timeoutMs, {
      allowErrorStatus: true,
      providerName: this.info.name,
      headers: { Authorization: `Bearer ${apiKey}` },
      extraCa: this.extraCa(),
      tlsHint:
        'Ask IT to allow www.oanda.com without SSL inspection, or export your firewall’s CA certificate to a .pem file and set OANDA_CA_CERT_FILE in backend/.env.',
    });
    if (status !== 200) throw this.mapError(status, body, base);

    const parsed = successSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError(502, 'UPSTREAM_INVALID_RESPONSE', `${this.info.name} returned data in an unexpected format.`, {
        issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    const { quotes: raw, meta, base_currency } = parsed.data;
    if (base_currency && base_currency !== base) {
      throw new AppError(502, 'UPSTREAM_INVALID_RESPONSE', `${this.info.name} returned base ${base_currency}, expected ${base}.`);
    }

    const quotes: Record<string, number> = {};
    let stamp: Date | null = null;
    for (const [code, q] of Object.entries(raw)) {
      const v = q[t.field];
      const n = v === undefined ? NaN : Number(v);
      if (isIsoCurrency(code) && Number.isFinite(n) && n > 0) quotes[code] = n;
      if (!stamp && q.date) {
        const d = parseOandaDate(q.date);
        if (!Number.isNaN(d.getTime())) stamp = d;
      }
    }
    if (Object.keys(quotes).length === 0) {
      throw new AppError(
        502,
        'PROVIDER_PLAN_LIMIT',
        `OANDA returned no ${t.label.toLowerCase()} rates${meta?.skipped_currencies?.length ? ` (skipped: ${meta.skipped_currencies.join(', ')})` : ''}. ` +
          'That rate type or those currencies may not be included in your subscription. Try OANDA_RATE_TYPE=midpoint.',
      );
    }
    quotes[base] = 1;

    const effective = meta?.effective_params?.date && dateRe.test(meta.effective_params.date) ? meta.effective_params.date : stamp?.toISOString().slice(0, 10);
    if (!effective) {
      throw new AppError(502, 'UPSTREAM_INVALID_RESPONSE', `${this.info.name} did not say which date the rates are for.`);
    }
    return {
      provider: this.info,
      base,
      quotes,
      effectiveDate: date ?? effective,
      publishedAt: stamp ? stamp.toISOString() : null,
      nextUpdateAt: null,
    };
  }

  /** Turns OANDA's { code, message } error body into a specific, actionable AppError. The key is never included. */
  private mapError(status: number, body: unknown, base: string): AppError {
    const e = errorSchema.safeParse(body);
    let msg = e.success ? e.data.message : undefined;
    if (msg && this.opts.apiKey) msg = msg.split(this.opts.apiKey).join('***');
    const code = e.success && e.data.code !== undefined ? ` code ${e.data.code}` : '';
    const said = msg ? ` OANDA said (${status}${code}): “${msg}”.` : ` (HTTP ${status}${code}).`;

    if (/trial|expired|subscription|licen[cs]e/i.test(msg ?? '') && status !== 429) {
      return new AppError(
        502,
        'PROVIDER_TRIAL_EXPIRED',
        `OANDA reports that the trial or subscription is not active, so no rates can be retrieved.${said} Contact OANDA to extend the trial or start a subscription.`,
      );
    }
    if (status === 429 || /quota|limit|exceed/i.test(msg ?? '')) {
      return new AppError(
        429,
        'PROVIDER_QUOTA_EXCEEDED',
        `OANDA request limit reached.${said} Cached rates are used where available; try again later or ask OANDA about a higher quota.`,
      );
    }
    if (status === 401) {
      return new AppError(
        502,
        'PROVIDER_AUTH_FAILED',
        `OANDA rejected the API key.${said} Check OANDA_API_KEY in backend/.env (no quotes or spaces around it).`,
      );
    }
    if (status === 403) {
      return new AppError(502, 'PROVIDER_PLAN_LIMIT', `OANDA: this request is not allowed on the current plan.${said}`);
    }
    if ((status === 400 || status === 404 || status === 422) && /currenc|base|quote/i.test(msg ?? '')) {
      return new AppError(400, 'UNSUPPORTED_CURRENCY', `OANDA does not support this currency request for base ${base}.${said}`);
    }
    return new AppError(502, 'UPSTREAM_HTTP_ERROR', `OANDA returned an error.${said}`);
  }
}
