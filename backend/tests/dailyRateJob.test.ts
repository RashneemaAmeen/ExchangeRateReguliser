import { describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors.js';
import { DailyRateJob, zonedParts, zonedToUtc } from '../src/services/dailyRateJob.js';
import { EffectiveRateService } from '../src/services/effectiveRateService.js';
import { createRateSources } from '../src/services/rateSources.js';
import { AED_QUOTES, FakeProvider, testConfig } from './helpers.js';

/** All 11 ERP base currencies present. */
const ALL_QUOTES = { ...AED_QUOTES, BHD: 0.102383, OMR: 0.104822, QAR: 0.991, THB: 8.9 };

function setup(startIso: string) {
  let now = new Date(startIso);
  const clock = () => now;
  const provider = new FakeProvider('primary', ALL_QUOTES, '2026-11-13', '2026-11-13T00:02:32.000Z');
  const config = testConfig({ cacheTtlSeconds: 600 });
  const sources = createRateSources(config, { exchangeRateApi: [provider], currencyApiCom: [new FakeProvider('currencyapi-com', ALL_QUOTES, '2026-11-13', '2026-11-13T00:02:32.000Z')], oanda: [new FakeProvider('oanda', ALL_QUOTES, '2026-11-13', '2026-11-13T00:02:32.000Z')] }, clock);
  const effective = new EffectiveRateService({ rateDecimalPlaces: 8, maxDeviationPercent: 5 }, clock);
  const job = new DailyRateJob({ sources, effective, config }, clock);
  return { job, provider, effective, setNow: (iso: string) => (now = new Date(iso)) };
}

describe('time-zone helpers', () => {
  it('converts between UTC and Asia/Dubai local time', () => {
    expect(zonedParts(new Date('2026-11-13T04:00:00Z'), 'Asia/Dubai')).toEqual({ date: '2026-11-13', time: '08:00' });
    expect(zonedToUtc('2026-11-13', '08:00', 'Asia/Dubai').toISOString()).toBe('2026-11-13T04:00:00.000Z');
  });
});

describe('DailyRateJob', () => {
  it('waits until 08:00 Dubai time, then makes rates effective for every country automatically', async () => {
    const { job, provider, effective, setNow } = setup('2026-11-13T03:30:00Z'); // 07:30 Dubai
    await job.tick();
    expect(provider.calls).toBe(0);
    expect(job.getState().nextRunAt).toBe('2026-11-13T04:00:00.000Z');

    setNow('2026-11-13T04:00:30Z'); // 08:00 Dubai
    await job.tick();
    const state = job.getState();
    expect(state.lastRun?.status).toBe('success');
    expect(state.lastRun?.countries.filter((c) => c.providerId === 'exchangerate-api')).toHaveLength(11);
    const sa = effective.list('exchangerate-api', 'SA');
    expect(sa.length).toBeGreaterThan(0);
    expect(sa.every((r) => r.rateType === 'AUTOMATIC' && r.rate && r.baseCurrency === 'SAR')).toBe(true);
    expect(sa.find((r) => r.currencyCode === 'USD')?.rate).toBe('3.75000184');
    expect(state.nextRunAt).toBe('2026-11-14T04:00:00.000Z');

    const calls = provider.calls;
    setNow('2026-11-13T09:00:00Z');
    await job.tick();
    expect(provider.calls).toBe(calls);
  });

  it('catches up straight away when the server starts after 08:00', async () => {
    const { job } = setup('2026-11-13T07:15:00Z'); // 11:15 Dubai
    await job.tick();
    expect(job.getState().lastRun).toMatchObject({ trigger: 'schedule', status: 'success', localDate: '2026-11-13' });
  });

  it('retries when the provider is down and keeps current rates meanwhile', async () => {
    const { job, provider, setNow } = setup('2026-11-13T04:01:00Z');
    provider.failWith = new AppError(502, 'UPSTREAM_TIMEOUT', 'Provider timed out');
    await job.tick();
    let state = job.getState();
    expect(state.lastRun?.status).toBe('retrying');
    expect(state.lastRun?.message).toMatch(/Current rates stay effective/);
    expect(state.nextRunAt).toBe('2026-11-13T04:16:00.000Z');

    setNow('2026-11-13T04:10:00Z');
    await job.tick();
    expect(job.getState().lastRun?.attempt).toBe(1);

    provider.failWith = null;
    setNow('2026-11-13T04:16:00Z');
    await job.tick();
    state = job.getState();
    expect(state.lastRun).toMatchObject({ trigger: 'retry', attempt: 2, status: 'success' });
  });

  it('gives up for the day after the maximum attempts', async () => {
    const { job, provider, setNow } = setup('2026-11-13T04:00:00Z');
    provider.failWith = new AppError(502, 'UPSTREAM_TIMEOUT', 'down');
    let t = new Date('2026-11-13T04:00:00Z').getTime();
    for (let i = 0; i < 8; i++) {
      setNow(new Date(t).toISOString());
      await job.tick();
      t += 15 * 60_000;
    }
    const state = job.getState();
    expect(state.lastRun).toMatchObject({ status: 'failed', attempt: 8 });
    expect(state.nextRunAt).toBe('2026-11-14T04:00:00.000Z');
  });

  it('a manual run does not use up the scheduled run', async () => {
    const { job, setNow } = setup('2026-11-13T02:00:00Z'); // 06:00 Dubai
    await job.run('manual');
    expect(job.getState().lastRun?.trigger).toBe('manual');
    setNow('2026-11-13T04:00:00Z');
    await job.tick();
    expect(job.getState().lastRun?.trigger).toBe('schedule');
  });

  it('leaves manual overrides untouched on the next automatic update', async () => {
    const { job, effective, provider, setNow } = setup('2026-11-13T04:00:00Z');
    await job.tick();
    effective.override('exchangerate-api', 'AE', 'USD', '3.70', 'Bank contract rate', 'Finance Manager');
    provider.quotes = { ...provider.quotes, USD: 0.2722, EUR: 0.2431 };
    provider.effectiveDate = '2026-11-14';
    setNow('2026-11-14T04:00:00Z');
    await job.tick();
    const usd = effective.get('exchangerate-api', 'AE', 'USD');
    const eur = effective.get('exchangerate-api', 'AE', 'EUR');
    expect(usd).toMatchObject({ rate: '3.70000000', rateType: 'MANUAL_OVERRIDE' });
    expect(usd.latestApi?.effectiveDate).toBe('2026-11-14');
    expect(eur).toMatchObject({ rateType: 'AUTOMATIC', effectiveDate: '2026-11-14' });
    expect(job.getState().lastRun?.message).toMatch(/manual override\(s\) left unchanged/);
  });
});
