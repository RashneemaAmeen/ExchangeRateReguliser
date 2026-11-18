import { describe, expect, it } from 'vitest';
import { evaluateStaleness } from '../src/services/staleness.js';

const base = { staleAfterHours: 48, weekendDays: [0, 6], holidays: ['2026-12-02', '2026-12-03'] };

describe('evaluateStaleness', () => {
  it('is fresh when rates are dated today', () => {
    const r = evaluateStaleness({ ...base, effectiveDate: '2026-11-11', publishedAt: '2026-11-11T00:02:00Z', now: new Date('2026-11-11T09:00:00Z') });
    expect(r.status).toBe('fresh');
  });

  it('is fresh when rates are dated yesterday (today not yet published)', () => {
    const r = evaluateStaleness({ ...base, effectiveDate: '2026-11-10', publishedAt: null, now: new Date('2026-11-11T09:00:00Z') });
    expect(r.status).toBe('fresh');
  });

  it('is "delayed" when only a weekend separates the rate date from today', () => {
    // Fri 2026-11-06 -> Mon 2026-11-09 : Sat + Sun missing
    const r = evaluateStaleness({ ...base, effectiveDate: '2026-11-06', publishedAt: null, now: new Date('2026-11-09T10:00:00Z') });
    expect(r.status).toBe('delayed');
    expect(r.nonPublishingDays).toEqual(['2026-11-07', '2026-11-08']);
    expect(r.message).toMatch(/weekend\/holiday/);
  });

  it('treats configured public holidays as non-publishing days', () => {
    // Tue 2026-12-01 -> Fri 2026-12-04 : 2 Dec & 3 Dec are holidays
    const r = evaluateStaleness({ ...base, effectiveDate: '2026-12-01', publishedAt: null, now: new Date('2026-12-04T10:00:00Z') });
    expect(r.status).toBe('delayed');
  });

  it('is stale when a business day was missed', () => {
    // Mon 2026-11-09 -> Thu 2026-11-12: Tue + Wed missing
    const r = evaluateStaleness({ ...base, effectiveDate: '2026-11-09', publishedAt: null, now: new Date('2026-11-12T10:00:00Z') });
    expect(r.status).toBe('stale');
    expect(r.missingBusinessDays).toEqual(['2026-11-10', '2026-11-11']);
  });
});
