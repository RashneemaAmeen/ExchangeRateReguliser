import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { findCountry } from '../src/lib/countries.js';
import { DailyRateJob } from '../src/services/dailyRateJob.js';
import { EffectiveRateService, type AutoUpdateInput } from '../src/services/effectiveRateService.js';
import type { NormalisedRate } from '../src/services/rateMath.js';
import { AppError } from '../src/lib/errors.js';
import { AED_QUOTES, FakeProvider, fixedNow, testConfig } from './helpers.js';

const UAE = findCountry('AE');
const fresh = { status: 'fresh' as const, ageHours: 1, missingBusinessDays: [], nonPublishingDays: [], message: 'ok' };
const rate = (code: string, value: string): NormalisedRate => ({ currencyCode: code, currencyName: code, rate: value, inverseRate: '1', direction: '' });
const P = { id: 'exchangerate-api', label: 'ExchangeRate-API' };

function svc() {
  let n = 0;
  const s = new EffectiveRateService({ rateDecimalPlaces: 8, maxDeviationPercent: 5 }, () => new Date('2026-11-13T04:00:00Z'), () => `id-${++n}`);
  const update = (rates: NormalisedRate[], over: Partial<AutoUpdateInput> = {}) =>
    s.applyAutoUpdate({
      provider: P,
      country: UAE,
      rates,
      effectiveDate: '2026-11-13',
      retrievedAt: '2026-11-13T04:00:00Z',
      staleness: fresh,
      source: 'Fake',
      ...over,
    });
  return { s, update };
}

describe('EffectiveRateService – automatic updates', () => {
  it('applies validated rates automatically, with history and audit', () => {
    const { s, update } = svc();
    const r = update([rate('USD', '3.6725'), rate('EUR', '4.06')]);
    expect(r).toMatchObject({ updated: 2, held: 0 });
    const usd = s.get('exchangerate-api', 'AE', 'USD');
    expect(usd).toMatchObject({ rate: '3.67250000', rateType: 'AUTOMATIC', effectiveDate: '2026-11-13', updatedBy: 'Automatic update' });
    expect(s.history('exchangerate-api', 'AE', 'USD')[0]).toMatchObject({ kind: 'AUTO_UPDATE', rate: '3.67250000', previousRate: null });
    expect(s.auditLog().map((a) => a.action)).toEqual(['RATE_UPDATED', 'RATE_UPDATED']);
  });

  it('does not rewrite an unchanged rate for the same date', () => {
    const { s, update } = svc();
    update([rate('USD', '3.6725')]);
    expect(update([rate('USD', '3.6725')])).toMatchObject({ updated: 0, unchanged: 1 });
    expect(s.history('exchangerate-api', 'AE', 'USD')).toHaveLength(1);
  });

  it('holds a move above 5% and keeps the current rate until the editor accepts it', () => {
    const { s, update } = svc();
    update([rate('USD', '3.6725')]);
    const r = update([rate('USD', '3.95')], { effectiveDate: '2026-11-14' });
    expect(r.held).toBe(1);
    const usd = s.get('exchangerate-api', 'AE', 'USD');
    expect(usd.rate).toBe('3.67250000');
    expect(usd.held).toMatchObject({ apiRate: '3.95000000', deviationPercent: '7.56' });
    const accepted = s.acceptHeld('exchangerate-api', 'AE', 'USD', 'Finance Manager');
    expect(accepted).toMatchObject({ rate: '3.95000000', held: null, rateType: 'AUTOMATIC' });
    expect(s.history('exchangerate-api', 'AE', 'USD')[0]).toMatchObject({ kind: 'API_RATE_ACCEPTED', previousRate: '3.67250000', user: 'Finance Manager' });
  });

  it('checks the first rate against the provider’s previous day', () => {
    const { s, update } = svc();
    update([rate('USD', '3.95')], { previousDay: { effectiveDate: '2026-11-12', rates: { USD: '3.6725' } } });
    expect(s.get('exchangerate-api', 'AE', 'USD')).toMatchObject({ rate: null, held: { apiRate: '3.95000000' } });
  });

  it('keeps current rates when the source data is stale', () => {
    const { s, update } = svc();
    update([rate('USD', '3.6725')]);
    const r = update([rate('USD', '3.68')], { staleness: { ...fresh, status: 'stale', message: 'old' }, effectiveDate: '2026-11-14' });
    expect(r.staleSource).toBe(true);
    expect(s.get('exchangerate-api', 'AE', 'USD').rate).toBe('3.67250000');
  });
});

describe('EffectiveRateService – manual override', () => {
  it('overrides one rate only, records who/when/previous/new/reason, and survives automatic updates', () => {
    const { s, update } = svc();
    update([rate('USD', '3.6725'), rate('EUR', '4.06')]);
    const o = s.override('exchangerate-api', 'AE', 'USD', '3.70', 'Bank contract rate', 'Finance Manager');
    expect(o).toMatchObject({ rate: '3.70000000', rateType: 'MANUAL_OVERRIDE' });
    expect(o.override).toMatchObject({ rate: '3.70000000', previousRate: '3.67250000', reason: 'Bank contract rate', by: 'Finance Manager', at: '2026-11-13T04:00:00.000Z' });
    expect(s.get('exchangerate-api', 'AE', 'EUR').rate).toBe('4.06000000'); // untouched

    const r = update([rate('USD', '3.68'), rate('EUR', '4.07')], { effectiveDate: '2026-11-14' });
    expect(r).toMatchObject({ keptOverride: 1, updated: 1 });
    expect(s.get('exchangerate-api', 'AE', 'USD')).toMatchObject({ rate: '3.70000000', latestApi: { rate: '3.68000000' } });
    expect(s.get('exchangerate-api', 'AE', 'EUR').rate).toBe('4.07000000');

    const audit = s.auditLog().find((a) => a.action === 'MANUAL_OVERRIDE');
    expect(audit).toMatchObject({ user: 'Finance Manager', previousRate: '3.67250000', newRate: '3.70000000', reason: 'Bank contract rate', currencyCode: 'USD' });
  });

  it('Resume Auto Update restores the latest API rate', () => {
    const { s, update } = svc();
    update([rate('USD', '3.6725')]);
    s.override('exchangerate-api', 'AE', 'USD', '3.70', 'Bank contract rate', 'Finance Manager');
    update([rate('USD', '3.68')], { effectiveDate: '2026-11-14' });
    const r = s.resumeAuto('exchangerate-api', 'AE', 'USD', 'Finance Manager');
    expect(r).toMatchObject({ rate: '3.68000000', rateType: 'AUTOMATIC', override: null, effectiveDate: '2026-11-14' });
    expect(s.history('exchangerate-api', 'AE', 'USD')[0]).toMatchObject({ kind: 'OVERRIDE_REMOVED', previousRate: '3.70000000' });
    expect(() => s.resumeAuto('exchangerate-api', 'AE', 'USD', 'x')).toThrow(/already updated automatically/);
  });

  it('validates override input', () => {
    const { s, update } = svc();
    update([rate('USD', '3.6725')]);
    expect(() => s.override('exchangerate-api', 'AE', 'USD', '-1', 'reason', 'x')).toThrow(/positive decimal/);
    expect(() => s.override('exchangerate-api', 'AE', 'USD', '3.7', '', 'x')).toThrow(/reason/);
    expect(() => s.override('exchangerate-api', 'AE', 'JPY', '1', 'reason', 'x')).toThrow(/No JPY rate exists/);
  });
});

/* ---------------------------------------------------------------- API & permissions */

const ALL_QUOTES = { ...AED_QUOTES, BHD: 0.102383, OMR: 0.104822, QAR: 0.991, THB: 8.9 };

async function build(passcode: string | null = 'letmein') {
  const base = testConfig({ erpCurrencies: ['AED', 'USD', 'EUR', 'SAR'] });
  const config = { ...base, erpEditor: { name: 'Finance Manager', passcode }, currencyApiCom: { ...base.currencyApiCom, apiKey: 'test-key' } };
  const app = createApp({
    config,
    providers: [new FakeProvider('primary', ALL_QUOTES, '2026-11-13', '2026-11-13T00:02:32.000Z')],
    currencyApiComProviders: [new FakeProvider('currencyapi-com', ALL_QUOTES, '2026-11-13', '2026-11-13T00:02:32.000Z')],
    now: fixedNow('2026-11-13T05:00:00.000Z'),
  });
  await (app.locals.dailyJob as DailyRateJob).run('startup');
  return app;
}

const login = async (app: Awaited<ReturnType<typeof build>>) =>
  (await request(app).post('/api/auth/login').send({ passcode: 'letmein' }).expect(200)).body.token as string;

describe('ERP rates API', () => {
  it('shows automatically updated rates to everyone, read-only', async () => {
    const app = await build();
    const res = await request(app).get('/api/erp-preview?country=AE').expect(200);
    expect(res.body.rates.map((r: { currencyCode: string }) => r.currencyCode)).toEqual(['EUR', 'SAR', 'USD']);
    expect(res.body.rates.every((r: { rateType: string }) => r.rateType === 'AUTOMATIC')).toBe(true);
    expect(res.body.editor).toMatchObject({ configured: true, name: 'Finance Manager', signedIn: false });
    expect(JSON.stringify(res.body)).not.toContain('letmein');
  });

  it('refuses edits without the editor session (backend enforcement)', async () => {
    const app = await build();
    const body = { country: 'AE', currency: 'USD', rate: '3.7', reason: 'Bank contract rate' };
    const noToken = await request(app).post('/api/erp-preview/rates/override').send(body).expect(403);
    expect(noToken.body.error.code).toBe('FORBIDDEN');
    await request(app).post('/api/erp-preview/rates/override').set('Authorization', 'Bearer forged').send(body).expect(403);
    await request(app).post('/api/erp-preview/rates/resume').send({ country: 'AE', currency: 'USD' }).expect(403);
    await request(app).post('/api/erp-preview/schedule/run').send({}).expect(403);
    await request(app).delete('/api/erp-preview').expect(403);
    const after = await request(app).get('/api/erp-preview?country=AE').expect(200);
    expect(after.body.rates.find((r: { currencyCode: string }) => r.currencyCode === 'USD').rateType).toBe('AUTOMATIC');
  });

  it('lets the signed-in editor override and resume, per provider', async () => {
    const app = await build();
    await request(app).post('/api/auth/login').send({ passcode: 'wrong' }).expect(401);
    const token = await login(app);
    const auth = { Authorization: `Bearer ${token}` };
    const me = await request(app).get('/api/auth/me').set(auth).expect(200);
    expect(me.body.session.name).toBe('Finance Manager');

    const o = await request(app)
      .post('/api/erp-preview/rates/override')
      .set(auth)
      .send({ country: 'AE', currency: 'USD', rate: '3.7', reason: 'Bank contract rate' })
      .expect(200);
    expect(o.body.rate).toMatchObject({ rate: '3.70000000', rateType: 'MANUAL_OVERRIDE', override: { by: 'Finance Manager' } });

    // The currencyapi.com table is separate and unchanged.
    const other = await request(app).get('/api/erp-preview?country=AE&provider=currencyapi-com').expect(200);
    expect(other.body.rates.find((r: { currencyCode: string }) => r.currencyCode === 'USD').rateType).toBe('AUTOMATIC');

    const hist = await request(app).get('/api/erp-preview/history?country=AE&currency=USD').expect(200);
    expect(hist.body.history[0]).toMatchObject({ kind: 'MANUAL_OVERRIDE', previousRate: '3.67250105', rate: '3.70000000' });
    const audit = await request(app).get('/api/erp-preview/audit?country=AE').expect(200);
    expect(audit.body.events[0]).toMatchObject({ action: 'MANUAL_OVERRIDE', user: 'Finance Manager' });

    const sql = await request(app).get('/api/erp-preview/sql?country=AE').expect(200);
    expect(sql.text).toContain("'MANUAL_OVERRIDE', 3.67250105, N'Bank contract rate'");
    expect(sql.text).toMatch(/NOT EXECUTED/);

    await request(app).post('/api/erp-preview/rates/resume').set(auth).send({ country: 'AE', currency: 'USD' }).expect(200);
    await request(app).post('/api/auth/logout').set(auth).expect(200);
    await request(app).post('/api/erp-preview/rates/resume').set(auth).send({ country: 'AE', currency: 'USD' }).expect(403);
  });

  it('turns editing off when no passcode is configured', async () => {
    const app = await build(null);
    const res = await request(app).post('/api/auth/login').send({ passcode: 'anything' }).expect(403);
    expect(res.body.error.message).toMatch(/ERP_EDITOR_PASSCODE/);
  });

  it('locks sign-in after repeated wrong passcodes', async () => {
    const app = await build();
    for (let i = 0; i < 5; i++) await request(app).post('/api/auth/login').send({ passcode: 'nope' }).expect(401);
    await request(app).post('/api/auth/login').send({ passcode: 'letmein' }).expect(429);
  });
});

describe('Clear simulation', () => {
  it('reloads fresh rates immediately and shows the reset in the audit log', async () => {
    const app = await build();
    const token = await login(app);
    const auth = { Authorization: `Bearer ${token}` };
    await request(app)
      .post('/api/erp-preview/rates/override')
      .set(auth)
      .send({ country: 'AE', currency: 'USD', rate: '3.7', reason: 'Bank contract rate' })
      .expect(200);
    await request(app).delete('/api/erp-preview').set(auth).expect(200);
    const after = await request(app).get('/api/erp-preview?country=AE').expect(200);
    expect(after.body.rates.length).toBe(3);
    expect(after.body.rates.find((r: { currencyCode: string }) => r.currencyCode === 'USD').rateType).toBe('AUTOMATIC');
    const audit = await request(app).get('/api/erp-preview/audit?country=AE').expect(200);
    expect(audit.body.events.some((e: { action: string }) => e.action === 'SIMULATION_RESET')).toBe(true);
  });
});

describe('OANDA in the ERP', () => {
  const OANDA_Q = { ...ALL_QUOTES, USD: 0.2723, EUR: 0.2431 };

  async function buildThree(oandaKey: string | null = 'oanda-test-key') {
    const base = testConfig({ erpCurrencies: ['AED', 'USD', 'EUR', 'SAR'] });
    const config = {
      ...base,
      erpEditor: { name: 'Finance Manager', passcode: 'letmein' },
      currencyApiCom: { ...base.currencyApiCom, apiKey: 'test-key' },
      oanda: { ...base.oanda, apiKey: oandaKey },
    };
    const stamp = ['2026-11-13', '2026-11-13T00:02:32.000Z'] as const;
    const app = createApp({
      config,
      providers: [new FakeProvider('primary', ALL_QUOTES, ...stamp)],
      currencyApiComProviders: [new FakeProvider('currencyapi-com', ALL_QUOTES, ...stamp)],
      oandaProviders: [new FakeProvider('oanda', OANDA_Q, stamp[0], '2026-11-12T21:00:00.000Z', true)],
      now: fixedNow('2026-11-13T05:00:00.000Z'),
    });
    await (app.locals.dailyJob as DailyRateJob).run('startup');
    return app;
  }

  it('the automatic update fills OANDA’s own effective rates, labelled with the OANDA rate type', async () => {
    const app = await buildThree();
    const res = await request(app).get('/api/erp-preview?provider=oanda&country=AE').expect(200);
    const usd = res.body.rates.find((r: { currencyCode: string }) => r.currencyCode === 'USD');
    expect(usd).toMatchObject({ providerId: 'oanda', providerName: 'OANDA', rateType: 'AUTOMATIC', rateLabel: 'Daily average midpoint (OANDA)' });
    expect(usd.rate).toBe('3.67242012'); // 1 / 0.2723, not the ExchangeRate-API value
    expect(usd.source).toMatch(/\[Daily average midpoint \(OANDA\)\]/); // UAE base is AED itself: nothing is cross-calculated
    const sa = await request(app).get('/api/erp-preview?provider=oanda&country=SA').expect(200);
    expect(sa.body.rates.find((r: { currencyCode: string }) => r.currencyCode === 'USD').source).toMatch(/\[Daily average midpoint \(OANDA\), cross via AED\]/);
    const other = await request(app).get('/api/erp-preview?provider=exchangerate-api&country=AE').expect(200);
    expect(other.body.rates.find((r: { currencyCode: string }) => r.currencyCode === 'USD').rate).toBe('3.67250105');
  });

  it('OANDA overrides are separate from the other providers and survive the next automatic update', async () => {
    const app = await buildThree();
    const token = (await request(app).post('/api/auth/login').send({ passcode: 'letmein' }).expect(200)).body.token as string;
    const auth = { Authorization: `Bearer ${token}` };
    await request(app).post('/api/erp-preview/rates/override').set(auth).send({ provider: 'oanda', country: 'AE', currency: 'USD', rate: '3.70', reason: 'Bank contract rate' }).expect(200);

    await request(app).post('/api/erp-preview/schedule/run').set(auth).send({}).expect(200);
    const oanda = await request(app).get('/api/erp-preview?provider=oanda&country=AE').expect(200);
    expect(oanda.body.rates.find((r: { currencyCode: string }) => r.currencyCode === 'USD')).toMatchObject({ rate: '3.70000000', rateType: 'MANUAL_OVERRIDE' });
    for (const p of ['exchangerate-api', 'currencyapi-com']) {
      const res = await request(app).get(`/api/erp-preview?provider=${p}&country=AE`).expect(200);
      expect(res.body.rates.find((r: { currencyCode: string }) => r.currencyCode === 'USD').rateType).toBe('AUTOMATIC');
    }
    const audit = await request(app).get('/api/erp-preview/audit?provider=oanda&country=AE').expect(200);
    expect(audit.body.events.some((e: { action: string; user: string }) => e.action === 'MANUAL_OVERRIDE' && e.user === 'Finance Manager')).toBe(true);
  });

  it('refuses OANDA edits without the editor session', async () => {
    const app = await buildThree();
    await request(app).post('/api/erp-preview/rates/override').send({ provider: 'oanda', country: 'AE', currency: 'USD', rate: '3.7', reason: 'Bank contract rate' }).expect(403);
  });

  it('the daily update skips OANDA when it has no key, and still succeeds for the others', async () => {
    const app = await buildThree(null);
    const state = (await request(app).get('/api/erp-preview/schedule').expect(200)).body;
    expect(state.providers.map((p: { id: string }) => p.id)).toEqual(['exchangerate-api', 'currencyapi-com']);
    expect(state.lastRun.status).toBe('success');
    const oanda = await request(app).get('/api/erp-preview?provider=oanda&country=AE').expect(200);
    expect(oanda.body.rates).toEqual([]);
  });

  it('a failing OANDA reports its own error and does not stop the other providers', async () => {
    const base = testConfig({ erpCurrencies: ['AED', 'USD', 'EUR', 'SAR'] });
    const config = { ...base, oanda: { ...base.oanda, apiKey: 'k' } };
    const stamp = ['2026-11-13', '2026-11-13T00:02:32.000Z'] as const;
    const bad = new FakeProvider('oanda', OANDA_Q, stamp[0], null, true);
    bad.failWith = new AppError(502, 'PROVIDER_TRIAL_EXPIRED', 'OANDA reports that the trial or subscription is not active.');
    const app = createApp({
      config,
      providers: [new FakeProvider('primary', ALL_QUOTES, ...stamp)],
      currencyApiComProviders: [new FakeProvider('currencyapi-com', ALL_QUOTES, ...stamp)],
      oandaProviders: [bad],
      now: fixedNow('2026-11-13T05:00:00.000Z'),
    });
    await (app.locals.dailyJob as DailyRateJob).run('startup');
    const run = (await request(app).get('/api/erp-preview/schedule').expect(200)).body.lastRun;
    expect(run.status).toBe('partial');
    expect(run.providers.find((p: { id: string }) => p.id === 'oanda')).toMatchObject({ ok: false });
    expect(run.message).toMatch(/OANDA/);
    const er = await request(app).get('/api/erp-preview?provider=exchangerate-api&country=AE').expect(200);
    expect(er.body.rates.length).toBeGreaterThan(0);
  });
});
