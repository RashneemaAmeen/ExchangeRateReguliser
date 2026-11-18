import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { AppError } from '../src/lib/errors.js';
import { FakeProvider, fixedNow, testConfig } from './helpers.js';

function build(opts: { cacheTtlSeconds?: number; minRefreshIntervalSeconds?: number } = {}) {
  const primary = new FakeProvider('primary');
  const fallback = new FakeProvider('fallback', { AED: 1, USD: 0.2723, EUR: 0.2433 });
  const app = createApp({ config: testConfig(opts), providers: [primary, fallback], now: fixedNow() });
  return { app, primary, fallback };
}

describe('GET /api/exchange-rates', () => {
  it('returns normalised default currencies with metadata', async () => {
    const { app } = build();
    const res = await request(app).get('/api/exchange-rates').expect(200);
    expect(res.body.target).toBe('AED');
    expect(res.body.rates.map((r: { currencyCode: string }) => r.currencyCode)).toEqual(['USD', 'EUR', 'GBP', 'INR', 'SAR', 'CNY']);
    expect(res.body.rates[0]).toMatchObject({ currencyName: 'US Dollar', rate: '3.67250105' });
    expect(res.body.provider.rateType).toBe('reference');
    expect(res.body.staleness.status).toBe('fresh');
    expect(res.body.disclaimer).toMatch(/not real-time/);
  });

  it('reports unsupported currencies without failing', async () => {
    const { app } = build();
    const res = await request(app).get('/api/exchange-rates?currencies=USD,BRL').expect(200);
    expect(res.body.unsupported).toEqual(['BRL']);
    expect(res.body.warnings.join()).toMatch(/BRL/);
  });

  it('rejects malformed currency codes', async () => {
    const { app } = build();
    const res = await request(app).get('/api/exchange-rates?currencies=US1').expect(400);
    expect(res.body.error.code).toBe('INVALID_CURRENCY');
  });

  it('caches responses and honours refresh=true', async () => {
    const { app, primary } = build();
    await request(app).get('/api/exchange-rates');
    const second = await request(app).get('/api/exchange-rates');
    expect(primary.calls).toBe(1);
    expect(second.body.servedFromCache).toBe(true);
    await request(app).get('/api/exchange-rates?refresh=true');
    expect(primary.calls).toBe(2);
  });

  it('throttles forced refreshes inside the minimum interval', async () => {
    const { app, primary } = build({ minRefreshIntervalSeconds: 60 });
    await request(app).get('/api/exchange-rates');
    const res = await request(app).get('/api/exchange-rates?refresh=true');
    expect(primary.calls).toBe(1);
    expect(res.body.warnings.join()).toMatch(/rate limits/);
  });

  it('falls back to the secondary provider when the primary fails', async () => {
    const { app, primary } = build();
    primary.failWith = new AppError(504, 'UPSTREAM_TIMEOUT', 'timed out');
    const res = await request(app).get('/api/exchange-rates?currencies=USD').expect(200);
    expect(res.body.provider.id).toBe('fallback');
    expect(res.body.usedFallback).toBe(true);
    expect(res.body.warnings.join()).toMatch(/fallback/);
  });

  it('serves last good data when all providers fail', async () => {
    const { app, primary, fallback } = build({ cacheTtlSeconds: 0 });
    await request(app).get('/api/exchange-rates').expect(200);
    primary.failWith = new AppError(502, 'UPSTREAM_NETWORK_ERROR', 'down');
    fallback.failWith = new AppError(502, 'UPSTREAM_NETWORK_ERROR', 'down');
    const res = await request(app).get('/api/exchange-rates').expect(200);
    expect(res.body.servedFromCache).toBe(true);
    expect(res.body.warnings.join()).toMatch(/All providers failed/);
  });

  it('returns 502 with structured error when nothing is available', async () => {
    const { app, primary, fallback } = build();
    primary.failWith = new AppError(504, 'UPSTREAM_TIMEOUT', 'timed out');
    fallback.failWith = new AppError(502, 'UPSTREAM_HTTP_ERROR', 'HTTP 500');
    const res = await request(app).get('/api/exchange-rates').expect(502);
    expect(res.body.error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(res.body.error.details.errors).toHaveLength(2);
  });
});

describe('other endpoints', () => {
  it('GET /api/exchange-rates/:currency', async () => {
    const { app } = build();
    const res = await request(app).get('/api/exchange-rates/sar').expect(200);
    expect(res.body.rate.currencyCode).toBe('SAR');
    expect(res.body.rate.direction).toMatch(/^1 SAR = 0\.979/);
    await request(app).get('/api/exchange-rates/BRL').expect(404);
  });

  it('GET /api/exchange-rates/convert', async () => {
    const { app } = build();
    const res = await request(app).get('/api/exchange-rates/convert?from=USD&to=AED&amount=250.50').expect(200);
    expect(res.body.result).toBe('919.96');
    await request(app).get('/api/exchange-rates/convert?from=USD&to=AED&amount=-1').expect(400);
    await request(app).get('/api/exchange-rates/convert?from=USD&to=AED&amount=1e5').expect(400);
  });

  it('GET /api/exchange-rates/history returns 501 when no provider supports it', async () => {
    const { app } = build();
    const res = await request(app).get('/api/exchange-rates/history?currency=USD').expect(501);
    expect(res.body.error.code).toBe('HISTORY_NOT_SUPPORTED');
  });

  it('GET /api/exchange-rates/status reports provider health', async () => {
    const { app } = build();
    await request(app).get('/api/exchange-rates');
    const res = await request(app).get('/api/exchange-rates/status').expect(200);
    expect(res.body.lastSuccessfulFetchAt).toBeTruthy();
    expect(res.body.providers[0].role).toBe('primary');
  });
});

