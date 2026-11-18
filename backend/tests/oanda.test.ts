import { readFileSync } from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchJson } from '../src/lib/http.js';
import { OandaProvider, type OandaOptions } from '../src/providers/oandaProvider.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CERT = path.join(here, 'fixtures', 'test-cert.pem');
const KEY = path.join(here, 'fixtures', 'test-key.pem');

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const opts = (over: Partial<OandaOptions> = {}): OandaOptions => ({
  baseUrl: 'https://api.example.test/rates/api/v1',
  apiKey: 'oanda-secret-key',
  timeoutMs: 1000,
  rateType: 'midpoint',
  quoteCurrencies: ['USD', 'EUR', 'AED'],
  historyMaxDays: 7,
  caCertFile: null,
  ...over,
});

/** OANDA v1 response for base AED. */
const okBody = (field: 'midpoint' | 'bid' | 'ask' = 'midpoint', date = '2026-11-16') => ({
  base_currency: 'AED',
  meta: { skipped_currencies: [], request_time: '2026-11-17T04:00:00+0000', effective_params: { date, fields: [field] } },
  quotes: {
    USD: { [field]: '0.2722940000', date: `${date}T21:00:00+0000` },
    EUR: { [field]: '0.2432780000', date: `${date}T21:00:00+0000` },
    BTC: { [field]: '0.0000025', date: `${date}T21:00:00+0000` },
  },
});

describe('OandaProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('calls the v1 rates endpoint with a Bearer header and maps the response', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(200, okBody()));
    vi.stubGlobal('fetch', fetchMock);
    const snap = await new OandaProvider(opts()).fetchLatest('AED');

    const [url, init] = fetchMock.mock.calls[0]!;
    const u = new URL(url);
    expect(u.pathname).toBe('/rates/api/v1/rates/AED.json');
    expect(u.searchParams.getAll('quote')).toEqual(['USD', 'EUR']); // base is never requested as its own quote
    expect(u.searchParams.get('fields')).toBe('midpoint');
    expect(u.searchParams.get('decimal_places')).toBe('10');
    expect(url).not.toContain('oanda-secret-key');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer oanda-secret-key');

    expect(snap.quotes).toEqual({ USD: 0.272294, EUR: 0.243278, AED: 1 }); // crypto dropped, base added
    expect(snap.effectiveDate).toBe('2026-11-16');
    expect(snap.publishedAt).toBe('2026-11-16T21:00:00.000Z');
    expect(snap.provider).toMatchObject({ id: 'oanda', rateLabel: 'Daily average midpoint (OANDA)', rateClass: 'MID' });
  });

  it('uses the averages field for bid and ask and labels them as such', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(200, okBody('bid')));
    vi.stubGlobal('fetch', fetchMock);
    const p = new OandaProvider(opts({ rateType: 'bid' }));
    const snap = await p.fetchLatest('AED');
    expect(new URL(fetchMock.mock.calls[0]![0]).searchParams.get('fields')).toBe('averages');
    expect(snap.quotes.USD).toBe(0.272294);
    expect(p.info).toMatchObject({ rateLabel: 'Daily average bid (OANDA)', rateClass: 'BID' });
  });

  it('asks for every currency when quoteCurrencies is "all"', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(200, okBody()));
    vi.stubGlobal('fetch', fetchMock);
    await new OandaProvider(opts({ quoteCurrencies: 'all' })).fetchLatest('AED');
    expect(new URL(fetchMock.mock.calls[0]![0]).searchParams.has('quote')).toBe(false);
  });

  it('explains a missing key without calling the API', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(new OandaProvider(opts({ apiKey: null })).fetchLatest('AED')).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED', status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, { code: 8, message: 'Malformed Authorization header or invalid access token' }, 'PROVIDER_AUTH_FAILED'],
    [401, { code: 3, message: 'Your trial has expired' }, 'PROVIDER_TRIAL_EXPIRED'],
    [403, { code: 4, message: 'Subscription expired' }, 'PROVIDER_TRIAL_EXPIRED'],
    [403, { code: 5, message: 'Not permitted' }, 'PROVIDER_PLAN_LIMIT'],
    [429, { code: 6, message: 'Too many requests' }, 'PROVIDER_QUOTA_EXCEEDED'],
    [400, { code: 7, message: 'Quota exceeded for this period' }, 'PROVIDER_QUOTA_EXCEEDED'],
    [400, { code: 9, message: 'Unknown base currency XYZ' }, 'UNSUPPORTED_CURRENCY'],
    [500, { code: 1, message: 'Internal error' }, 'UPSTREAM_HTTP_ERROR'],
  ])('maps HTTP %i %j to %s and quotes OANDA’s own message', async (status, body, code) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(status, body)));
    const err = await new OandaProvider(opts()).fetchLatest('AED').catch((e) => e);
    expect(err.code).toBe(code);
    expect(err.message).toContain(body.message);
  });

  it('never puts the API key in an error message, even if OANDA echoes it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { code: 8, message: 'invalid access token oanda-secret-key' })));
    const err = await new OandaProvider(opts()).fetchLatest('AED').catch((e) => e);
    expect(err.message).not.toContain('oanda-secret-key');
    expect(JSON.stringify(err.details ?? {})).not.toContain('oanda-secret-key');
  });

  it('reports a rate type the subscription does not include', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { base_currency: 'AED', quotes: { USD: { date: '2026-11-16T21:00:00+0000' } }, meta: { skipped_currencies: ['EUR'] } })));
    await expect(new OandaProvider(opts({ rateType: 'ask' })).fetchLatest('AED')).rejects.toMatchObject({ code: 'PROVIDER_PLAN_LIMIT' });
  });

  it('rejects an unexpected response shape', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { rates: {} })));
    await expect(new OandaProvider(opts()).fetchLatest('AED')).rejects.toMatchObject({ code: 'UPSTREAM_INVALID_RESPONSE' });
  });

  it('caches past days for the life of the process (history costs quota)', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(200, okBody('midpoint', '2026-11-10')));
    vi.stubGlobal('fetch', fetchMock);
    const p = new OandaProvider(opts());
    const a = await p.fetchHistorical('AED', '2026-11-10');
    await p.fetchHistorical('AED', '2026-11-10');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(fetchMock.mock.calls[0]![0]).searchParams.get('date')).toBe('2026-11-10');
    expect(a.effectiveDate).toBe('2026-11-10');
    expect(() => p.fetchHistorical('AED', 'yesterday')).toThrow(/Invalid date/);
  });

  it('does not cache a failed history request', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(500, { message: 'boom' })).mockResolvedValue(jsonResponse(200, okBody('midpoint', '2026-11-10')));
    vi.stubGlobal('fetch', fetchMock);
    const p = new OandaProvider(opts());
    await expect(p.fetchHistorical('AED', '2026-11-10')).rejects.toMatchObject({ code: 'UPSTREAM_HTTP_ERROR' });
    await expect(p.fetchHistorical('AED', '2026-11-10')).resolves.toMatchObject({ effectiveDate: '2026-11-10' });
  });

  it('reports an unusable certificate file without crashing the app', async () => {
    const p = new OandaProvider(opts({ caCertFile: path.join(here, 'fixtures', 'does-not-exist.pem') }));
    await expect(p.fetchLatest('AED')).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED', message: expect.stringContaining('file not found') });
  });
});

describe('TLS: certificate checking stays on', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('turns a certificate failure into a clear UPSTREAM_TLS_ERROR (fetch path)', async () => {
    const e = Object.assign(new TypeError('fetch failed'), { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } });
    vi.stubGlobal('fetch', vi.fn(async () => { throw e; }));
    const err = await new OandaProvider(opts()).fetchLatest('AED').catch((x) => x);
    expect(err).toMatchObject({ code: 'UPSTREAM_TLS_ERROR', status: 502 });
    expect(err.message).toMatch(/Sophos/);
    expect(err.message).toMatch(/OANDA_CA_CERT_FILE/);
    expect(err.message).not.toContain('oanda-secret-key');
  });

  describe('against a real local HTTPS server with a self-signed certificate', () => {
    async function withServer<T>(fn: (baseUrl: string, seen: { auth?: string; url?: string }) => Promise<T>): Promise<T> {
      const seen: { auth?: string; url?: string } = {};
      const server = https.createServer({ key: readFileSync(KEY), cert: readFileSync(CERT) }, (req, res) => {
        seen.auth = req.headers.authorization;
        seen.url = req.url;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(okBody()));
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      try {
        return await fn(`https://localhost:${(server.address() as AddressInfo).port}/rates/api/v1`, seen);
      } finally {
        server.close();
      }
    }

    it('rejects the untrusted certificate by default', async () => {
      await withServer(async (baseUrl) => {
        const err = await new OandaProvider(opts({ baseUrl })).fetchLatest('AED').catch((e) => e);
        expect(err).toMatchObject({ code: 'UPSTREAM_TLS_ERROR' });
      });
    });

    it('works once the CA is trusted explicitly via OANDA_CA_CERT_FILE, and still sends the Bearer header', async () => {
      await withServer(async (baseUrl, seen) => {
        const snap = await new OandaProvider(opts({ baseUrl, caCertFile: CERT })).fetchLatest('AED');
        expect(snap.quotes.USD).toBe(0.272294);
        expect(seen.auth).toBe('Bearer oanda-secret-key');
        expect(seen.url).toContain('/rates/api/v1/rates/AED.json?');
      });
    });

    it('fetchJson trusts only what it is told to trust', async () => {
      await withServer(async (baseUrl) => {
        const url = `${baseUrl}/currencies.json`;
        await expect(fetchJson(url, 2000)).rejects.toMatchObject({ code: 'UPSTREAM_TLS_ERROR' });
        await expect(fetchJson(url, 2000, { extraCa: [readFileSync(CERT, 'utf8')] })).resolves.toMatchObject({ status: 200 });
      });
    });
  });
});
