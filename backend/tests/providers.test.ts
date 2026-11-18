import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { AppError } from '../src/lib/errors.js';
import { CurrencyApiComProvider } from '../src/providers/currencyApiComProvider.js';
import { AED_QUOTES, FakeProvider, fixedNow, testConfig } from './helpers.js';

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('CurrencyApiComProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('maps the v3 latest response and sends the key only as a header', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse(200, {
        meta: { last_updated_at: '2026-11-12T23:59:59Z', base_currency: 'AED' },
        data: {
          USD: { code: 'USD', value: 0.27229 },
          EUR: { code: 'EUR', value: 0.2448 },
          BTC: { code: 'BTC', value: 0.0000025 },
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const p = new CurrencyApiComProvider('https://api.example.test/v3', 'secret-key', 1000);
    const snap = await p.fetchLatest('AED');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.example.test/v3/latest?base_currency=AED');
    expect(url).not.toContain('secret-key');
    expect((init!.headers as Record<string, string>).apikey).toBe('secret-key');
    expect(snap.quotes).toEqual({ USD: 0.27229, EUR: 0.2448, AED: 1 }); // crypto dropped, base added
    expect(snap.effectiveDate).toBe('2026-11-12');
    expect(snap.publishedAt).toBe('2026-11-12T23:59:59.000Z');
  });

  it('explains a missing key without calling the API', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const p = new CurrencyApiComProvider('https://api.example.test/v3', null, 1000);
    await expect(p.fetchLatest('AED')).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED', status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'PROVIDER_AUTH_FAILED'],
    [403, 'PROVIDER_PLAN_LIMIT'],
    [429, 'PROVIDER_QUOTA_EXCEEDED'],
    [500, 'UPSTREAM_HTTP_ERROR'],
  ])('maps HTTP %i to %s', async (status, code) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(status, { message: 'nope' })));
    const p = new CurrencyApiComProvider('https://api.example.test/v3', 'k', 1000);
    await expect(p.fetchLatest('AED')).rejects.toMatchObject({ code });
  });

  it('rejects an unexpected response shape', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { rates: {} })));
    const p = new CurrencyApiComProvider('https://api.example.test/v3', 'k', 1000);
    await expect(p.fetchLatest('AED')).rejects.toMatchObject({ code: 'UPSTREAM_INVALID_RESPONSE' });
  });
});

/** currencyapi side: USD 0.5% higher quote vs AED (so AED-per-USD is lower), EUR identical, no INR. */
const OTHER_QUOTES: Record<string, number> = { AED: 1, USD: 0.272294 * 1.005, EUR: 0.243278, GBP: 0.207011, SAR: 1.021103, CNY: 1.821036 };
/** OANDA side: USD identical, EUR 3% different (large), INR present. */
const OANDA_QUOTES: Record<string, number> = { AED: 1, USD: 0.272294, EUR: 0.243278 * 1.03, GBP: 0.207011, SAR: 1.021103, CNY: 1.821036, INR: 25.581698 };

function build(opts: { otherDate?: string; otherFails?: boolean; oandaDate?: string; oandaFails?: AppError; oandaClass?: 'MID' | 'BID' | 'ASK'; oandaKey?: string | null } = {}) {
  const existing = new FakeProvider('primary');
  const fallback = new FakeProvider('fallback', { AED: 1, USD: 0.2723 });
  const other = new FakeProvider('currencyapi-com', OTHER_QUOTES, opts.otherDate ?? '2026-11-11');
  const oanda = new FakeProvider('oanda', OANDA_QUOTES, opts.oandaDate ?? '2026-11-11', '2026-11-10T21:00:00.000Z', true, opts.oandaClass ?? 'MID');
  if (opts.otherFails) other.failWith = new AppError(429, 'PROVIDER_QUOTA_EXCEEDED', 'currencyapi.com request limit reached.');
  if (opts.oandaFails) oanda.failWith = opts.oandaFails;
  const base = testConfig();
  const config = { ...base, oanda: { ...base.oanda, apiKey: opts.oandaKey === undefined ? 'oanda-test-key' : opts.oandaKey } };
  const app = createApp({ config, providers: [existing, fallback], currencyApiComProviders: [other], oandaProviders: [oanda], now: fixedNow() });
  return { app, existing, other, oanda };
}

describe('Provider selection', () => {
  it('lists three providers without exposing any API key', async () => {
    const base = testConfig();
    const config = {
      ...base,
      currencyApiCom: { ...base.currencyApiCom, apiKey: 'sk-test-DO-NOT-LEAK' },
      oanda: { ...base.oanda, apiKey: 'oanda-DO-NOT-LEAK' },
    };
    const app = createApp({
      config,
      providers: [new FakeProvider('primary')],
      currencyApiComProviders: [new FakeProvider('currencyapi-com')],
      oandaProviders: [new FakeProvider('oanda')],
      now: fixedNow(),
    });
    for (const path of ['/api/providers', '/api/erp-preview', '/api/exchange-rates/status?provider=oanda', '/api/exchange-rates?provider=oanda&currencies=USD']) {
      const res = await request(app).get(path).expect(200);
      const text = JSON.stringify(res.body);
      expect(text).not.toContain('sk-test-DO-NOT-LEAK');
      expect(text).not.toContain('oanda-DO-NOT-LEAK');
    }
    const res = await request(app).get('/api/providers').expect(200);
    expect(res.body.default).toBe('exchangerate-api');
    expect(res.body.providers.map((p: { id: string }) => p.id)).toEqual(['exchangerate-api', 'currencyapi-com', 'oanda']);
    expect(res.body.providers[2]).toMatchObject({ label: 'OANDA', configured: true, setupHint: null, defaultRateType: 'midpoint' });
    expect(res.body.providers[2].rateTypes.map((t: { id: string }) => t.id)).toEqual(['midpoint', 'bid', 'ask']);
    expect(res.body.providers[0].rateTypes).toBeNull();
  });

  it('shows OANDA as not configured, with how to fix it, when there is no key', async () => {
    const { app } = build({ oandaKey: null });
    const res = await request(app).get('/api/providers').expect(200);
    expect(res.body.providers[2]).toMatchObject({ configured: false });
    expect(res.body.providers[2].setupHint).toMatch(/OANDA_API_KEY/);
  });

  it('serves rates from the chosen provider and rejects unknown providers', async () => {
    const { app, other, oanda } = build();
    const res = await request(app).get('/api/exchange-rates?provider=currencyapi-com&currencies=USD').expect(200);
    expect(res.body.provider.id).toBe('currencyapi-com');
    expect(other.calls).toBe(1);
    const o = await request(app).get('/api/exchange-rates?provider=oanda&currencies=USD').expect(200);
    expect(o.body.provider).toMatchObject({ id: 'oanda', rateLabel: 'Daily average midpoint (OANDA)', rateClass: 'MID' });
    expect(oanda.calls).toBe(1);
    await request(app).get('/api/exchange-rates?provider=nope').expect(400);
  });

  it('cross-calculates other targets from one AED snapshot for OANDA too (saves quota)', async () => {
    const { app, oanda } = build();
    const res = await request(app).get('/api/exchange-rates?provider=oanda&target=SAR&currencies=USD').expect(200);
    expect(res.body.target).toBe('SAR');
    expect(res.body.rates[0].direction).toBe('1 USD = 3.75000184 SAR');
    expect(oanda.calls).toBe(1); // FakeProvider only accepts AED – a SAR request would have failed
  });

  it('previews other OANDA rate types without touching the default service, and rejects unknown ones', async () => {
    const created: string[] = [];
    const base = testConfig();
    const app = createApp({
      config: { ...base, oanda: { ...base.oanda, apiKey: 'k' } },
      providers: [new FakeProvider('primary')],
      currencyApiComProviders: [new FakeProvider('currencyapi-com')],
      oandaProviders: (t) => {
        created.push(t);
        return [new FakeProvider('oanda', OANDA_QUOTES, '2026-11-11', null, true, t === 'bid' ? 'BID' : 'MID')];
      },
      now: fixedNow(),
    });
    const bid = await request(app).get('/api/exchange-rates?provider=oanda&rateType=bid&currencies=USD').expect(200);
    expect(bid.body.provider).toMatchObject({ rateLabel: 'Daily average bid (OANDA)', rateClass: 'BID' });
    const dflt = await request(app).get('/api/exchange-rates?provider=oanda&currencies=USD').expect(200);
    expect(dflt.body.provider.rateClass).toBe('MID');
    expect(created.sort()).toEqual(['bid', 'midpoint']);
    await request(app).get('/api/exchange-rates?provider=oanda&rateType=spot').expect(400);
  });

  it('a failing provider never breaks the others', async () => {
    const { app } = build({ otherFails: true });
    await request(app).get('/api/exchange-rates?currencies=USD').expect(200);
    await request(app).get('/api/exchange-rates?provider=oanda&currencies=USD').expect(200);
    const bad = await request(app).get('/api/exchange-rates?provider=currencyapi-com').expect(429);
    expect(bad.body.error.code).toBe('PROVIDER_QUOTA_EXCEEDED');
  });
});

describe('GET /api/exchange-rates/compare (all providers)', () => {
  it('compares three providers in the same direction and precision, with ExchangeRate-API as the reference', async () => {
    const { app } = build();
    const res = await request(app).get('/api/exchange-rates/compare?target=AED&currencies=USD,EUR,INR').expect(200);
    expect(res.body.referenceProvider).toBe('exchangerate-api');
    expect(res.body.providers.map((p: { id: string }) => p.id)).toEqual(['exchangerate-api', 'currencyapi-com', 'oanda']);
    expect(res.body.providers[0].reference).toBe(true);
    expect(res.body.providers[2]).toMatchObject({ ok: true, rateLabel: 'Daily average midpoint (OANDA)', publishedAt: '2026-11-10T21:00:00.000Z' });
    const rows = Object.fromEntries(res.body.rows.map((r: { currencyCode: string }) => [r.currencyCode, r]));

    expect(rows.USD.rates['exchangerate-api']).toBe('3.67250105');
    expect(rows.USD.rates.oanda).toBe('3.67250105');
    // currencyapi quote is 0.5% higher -> AED per USD is lower by 1 - 1/1.005 = 0.4975%
    expect(rows.USD.differences['currencyapi-com']).toMatchObject({ percent: '-0.4975', direction: 'LOWER', status: 'ALIGNED' });
    expect(rows.USD.differences.oanda).toMatchObject({ percent: '0.0000', direction: 'EQUAL', status: 'ALIGNED' });
    // OANDA EUR quote is 3% higher -> AED per EUR about 2.91% lower: large
    expect(rows.EUR.differences.oanda).toMatchObject({ direction: 'LOWER', status: 'LARGE_DIFFERENCE' });
    expect(Number(rows.EUR.differences.oanda.percent)).toBeCloseTo(-2.9126, 3);
    expect(rows.EUR.differences['currencyapi-com'].status).toBe('ALIGNED');
    // INR: only ExchangeRate-API and OANDA have it
    expect(rows.INR.rates['currencyapi-com']).toBeNull();
    expect(rows.INR.differences['currencyapi-com'].status).toBe('MISSING');
    expect(rows.INR.differences.oanda.status).toBe('ALIGNED');
    expect(res.body.effectiveDatesMatch).toBe(true);
    expect(res.body.rateTypesMatch).toBe(true);
    expect(res.body.warnings).toEqual([]);
  });

  it('warns when effective dates differ', async () => {
    const { app } = build({ oandaDate: '2026-11-10' });
    const res = await request(app).get('/api/exchange-rates/compare?currencies=USD').expect(200);
    expect(res.body.effectiveDatesMatch).toBe(false);
    expect(res.body.warnings.map((w: { kind: string }) => w.kind)).toEqual(['DATES']);
    expect(res.body.warnings[0].message).toMatch(/OANDA: 2026-11-10/);
  });

  it('warns when rate types are not comparable (bid vs mid-market)', async () => {
    const { app } = build({ oandaClass: 'BID' });
    const res = await request(app).get('/api/exchange-rates/compare?currencies=USD').expect(200);
    expect(res.body.rateTypesMatch).toBe(false);
    expect(res.body.warnings.map((w: { kind: string }) => w.kind)).toContain('RATE_TYPES');
    expect(res.body.providers[2].rateClass).toBe('BID');
  });

  it('keeps showing the other providers when one is unavailable', async () => {
    const { app } = build({ oandaFails: new AppError(502, 'PROVIDER_TRIAL_EXPIRED', 'OANDA reports that the trial has expired.') });
    const res = await request(app).get('/api/exchange-rates/compare?currencies=USD').expect(200);
    expect(res.body.providers[0].ok).toBe(true);
    expect(res.body.providers[1].ok).toBe(true);
    expect(res.body.providers[2]).toMatchObject({ ok: false, error: { code: 'PROVIDER_TRIAL_EXPIRED' } });
    const row = res.body.rows[0];
    expect(row.rates.oanda).toBeNull();
    expect(row.rates['exchangerate-api']).toBe('3.67250105');
    expect(row.differences['currencyapi-com'].status).toBe('ALIGNED');
    expect(row.differences.oanda.status).toBe('UNAVAILABLE');
    expect(res.body.rateTypesMatch).toBe(true); // judged on the providers that answered
  });

  it('shows the not-configured message for OANDA without a key, while comparing the others', async () => {
    const base = testConfig();
    const app = createApp({
      config: { ...base, oanda: { ...base.oanda, apiKey: null } },
      providers: [new FakeProvider('primary')],
      currencyApiComProviders: [new FakeProvider('currencyapi-com', OTHER_QUOTES)],
      now: fixedNow(), // OANDA uses the real adapter, which has no key
    });
    const res = await request(app).get('/api/exchange-rates/compare?currencies=USD').expect(200);
    expect(res.body.providers[2]).toMatchObject({ ok: false, error: { code: 'PROVIDER_NOT_CONFIGURED' } });
    expect(res.body.providers[2].error.message).toMatch(/OANDA_API_KEY/);
    expect(res.body.providers[0].ok).toBe(true);
  });

  it('is read-only: comparing never creates or changes effective ERP rates', async () => {
    const { app } = build();
    await request(app).get('/api/exchange-rates/compare?currencies=USD,EUR').expect(200);
    const erp = await request(app).get('/api/erp-preview?provider=oanda&country=AE').expect(200);
    expect(erp.body.rates).toEqual([]);
  });
});

// Keep the shared fixture referenced so a change to it is noticed here too.
void AED_QUOTES;
