import { loadConfig, type AppConfig } from '../src/config.js';
import { AppError } from '../src/lib/errors.js';
import type { ExchangeRateProvider, ProviderInfo, ProviderSnapshot } from '../src/providers/types.js';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return { ...loadConfig({}), minRefreshIntervalSeconds: 0, ...overrides };
}

/** Realistic AED-based quotes (units of X per 1 AED), matching open.er-api's shape. */
export const AED_QUOTES: Record<string, number> = {
  AED: 1,
  USD: 0.272294,
  EUR: 0.243278,
  GBP: 0.207011,
  INR: 25.581698,
  SAR: 1.021103,
  CNY: 1.821036,
  JPY: 41.96,
  KWD: 0.083571,
};

export class FakeProvider implements ExchangeRateProvider {
  calls = 0;
  failWith: AppError | null = null;
  info: ProviderInfo;

  constructor(
    id = 'fake',
    public quotes: Record<string, number> = AED_QUOTES,
    public effectiveDate = '2026-11-11',
    public publishedAt: string | null = '2026-11-11T00:02:32.000Z',
    supportsHistory = false,
    rateClass: 'MID' | 'BID' | 'ASK' = 'MID',
  ) {
    this.info = {
      id,
      name: `Fake ${id}`,
      website: 'https://example.invalid',
      attribution: 'test',
      rateType: 'reference',
      rateLabel: id === 'oanda' ? `Daily average ${{ MID: 'midpoint', BID: 'bid', ASK: 'ask' }[rateClass]} (OANDA)` : 'Reference (mid-market)',
      rateClass,
      updateFrequency: 'daily',
      supportsHistory,
      notes: '',
    };
  }

  async fetchLatest(base: string): Promise<ProviderSnapshot> {
    this.calls++;
    if (this.failWith) throw this.failWith;
    if (base !== 'AED') throw new AppError(400, 'UNSUPPORTED_CURRENCY', `unsupported ${base}`);
    return {
      provider: this.info,
      base,
      quotes: { ...this.quotes },
      effectiveDate: this.effectiveDate,
      publishedAt: this.publishedAt,
      nextUpdateAt: null,
    };
  }
}

export const fixedNow = (iso = '2026-11-11T08:00:00.000Z') => () => new Date(iso);
