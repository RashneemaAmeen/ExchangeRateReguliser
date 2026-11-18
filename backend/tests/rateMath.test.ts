import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/lib/decimal.js';
import { convert, normaliseRate } from '../src/services/rateMath.js';
import { FakeProvider } from './helpers.js';

const snapshot = await new FakeProvider().fetchLatest('AED');

describe('rate direction', () => {
  it('inverts AED-based quotes into "1 FCY = X AED"', () => {
    const usd = normaliseRate(snapshot, 'USD', 8);
    // 1 / 0.272294 = 3.67250105... -> AED peg of 3.6725 (within provider precision)
    expect(usd.rate).toBe('3.67250105');
    expect(usd.inverseRate).toBe('0.272294');
    expect(usd.direction).toBe('1 USD = 3.67250105 AED');
    expect(new Decimal(usd.rate).toDecimalPlaces(4).toFixed(4)).toBe('3.6725');
  });

  it('is correct for currencies worth less than 1 AED', () => {
    const inr = normaliseRate(snapshot, 'INR', 8);
    expect(inr.rate).toBe('0.03909045'); // 1 / 25.581698
    expect(new Decimal(inr.rate).lt(1)).toBe(true);
  });

  it('throws UNSUPPORTED_CURRENCY for codes the provider lacks', () => {
    expect(() => normaliseRate(snapshot, 'XAU', 8)).toThrowError(/not available/);
  });
});

describe('cross-currency conversion', () => {
  it('converts FCY -> AED', () => {
    const r = convert(snapshot, 'USD', 'AED', new Decimal('1000'), 8);
    expect(r.result).toBe('3672.50'); // 2 minor units for AED
  });

  it('converts AED -> FCY', () => {
    const r = convert(snapshot, 'AED', 'USD', new Decimal('3672.50'), 8);
    expect(r.result).toBe('1000.00');
  });

  it('converts between two non-AED currencies via AED using raw quotes', () => {
    const r = convert(snapshot, 'USD', 'INR', new Decimal('100'), 8);
    // 100 * 25.581698 / 0.272294 = 9394.81...
    const expected = new Decimal('100').mul('25.581698').div('0.272294');
    expect(r.result).toBe(expected.toDecimalPlaces(2).toFixed(2));
    expect(r.via).toBe('AED');
  });

  it('round-trips without floating point drift', () => {
    const there = convert(snapshot, 'EUR', 'GBP', new Decimal('0.1'), 12);
    const back = new Decimal(there.rate).mul(there.inverseRate);
    expect(back.minus(1).abs().lt('1e-11')).toBe(true);
    // classic float trap: 0.1 + 0.2
    expect(new Decimal('0.1').plus('0.2').toFixed()).toBe('0.3');
  });

  it('respects currency minor units (JPY 0, KWD 3)', () => {
    expect(convert(snapshot, 'USD', 'JPY', new Decimal('10'), 8).result).toMatch(/^\d+$/);
    expect(convert(snapshot, 'USD', 'KWD', new Decimal('10'), 8).result).toMatch(/^\d+\.\d{3}$/);
  });
});
