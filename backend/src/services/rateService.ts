import type { AppConfig } from '../config.js';
import { AppError, isAppError } from '../lib/errors.js';
import type { Decimal } from '../lib/decimal.js';
import type { ExchangeRateProvider, ProviderInfo, ProviderSnapshot } from '../providers/types.js';
import { convert, normaliseRate, rebaseRate, supportedCodes, type ConversionResult, type NormalisedRate } from './rateMath.js';
import { evaluateStaleness, type StalenessResult } from './staleness.js';

export const REFERENCE_RATE_DISCLAIMER =
  'Reference (mid-market) rates for information and testing only. They are not bank buy/sell or transaction rates, ' +
  'not an official CBUAE fixing, and not real-time.';

interface CacheEntry {
  snapshot: ProviderSnapshot;
  retrievedAt: Date;
  expiresAt: Date;
}

export interface SnapshotResult {
  snapshot: ProviderSnapshot;
  retrievedAt: Date;
  servedFromCache: boolean;
  usedFallback: boolean;
  warnings: string[];
  /** True when every provider failed and an older cached snapshot is being served instead. */
  allProvidersFailed?: boolean;
}

export interface RatesResponse {
  target: string;
  provider: ProviderInfo;
  effectiveDate: string;
  publishedAt: string | null;
  nextUpdateAt: string | null;
  retrievedAt: string;
  lastSuccessfulFetchAt: string | null;
  servedFromCache: boolean;
  usedFallback: boolean;
  cacheExpiresAt: string | null;
  staleness: StalenessResult;
  rates: NormalisedRate[];
  unsupported: string[];
  warnings: string[];
  disclaimer: string;
}

interface ProviderStatus {
  id: string;
  name: string;
  role: 'primary' | 'fallback';
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: { at: string; code: string; message: string } | null;
}

export class RateService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<SnapshotResult>>();
  private readonly providerStatus = new Map<string, ProviderStatus>();
  private readonly historyCache = new Map<string, Promise<ProviderSnapshot>>();
  private lastSuccessfulFetchAt: Date | null = null;

  constructor(
    private readonly providers: ExchangeRateProvider[],
    private readonly config: AppConfig,
    private readonly now: () => Date = () => new Date(),
    /**
     * crossFromFunctional: always fetch ONE snapshot in the functional currency (AED) and cross-calculate any
     * other target from it. Used for quota-limited providers so changing the target never costs a request.
     */
    private readonly options: { crossFromFunctional?: boolean } = {},
  ) {
    if (providers.length === 0) throw new Error('At least one provider is required');
    providers.forEach((p, i) =>
      this.providerStatus.set(p.info.id, {
        id: p.info.id,
        name: p.info.name,
        role: i === 0 ? 'primary' : 'fallback',
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastError: null,
      }),
    );
  }

  /** Get a snapshot for `target`, from cache when valid, otherwise from the provider chain. */
  async getSnapshot(target: string, forceRefresh = false): Promise<SnapshotResult> {
    const cached = this.cache.get(target);
    const now = this.now();

    if (cached) {
      const ageSeconds = (now.getTime() - cached.retrievedAt.getTime()) / 1000;
      if (!forceRefresh && now < cached.expiresAt) {
        return { snapshot: cached.snapshot, retrievedAt: cached.retrievedAt, servedFromCache: true, usedFallback: false, warnings: [] };
      }
      if (forceRefresh && ageSeconds < this.config.minRefreshIntervalSeconds) {
        return {
          snapshot: cached.snapshot,
          retrievedAt: cached.retrievedAt,
          servedFromCache: true,
          usedFallback: false,
          warnings: [
            `Rates were retrieved ${Math.round(ageSeconds)}s ago; returning the cached copy to respect provider rate limits ` +
              `(minimum interval ${this.config.minRefreshIntervalSeconds}s). The provider only publishes once per day.`,
          ],
        };
      }
    }

    // De-duplicate concurrent upstream requests for the same target.
    const existing = this.inflight.get(target);
    if (existing) return existing;
    const p = this.fetchFromChain(target).finally(() => this.inflight.delete(target));
    this.inflight.set(target, p);
    return p;
  }

  private async fetchFromChain(target: string): Promise<SnapshotResult> {
    const errors: { provider: string; code: string; message: string }[] = [];
    let lastError: AppError | null = null;

    for (const [index, provider] of this.providers.entries()) {
      const status = this.providerStatus.get(provider.info.id)!;
      status.lastAttemptAt = this.now().toISOString();
      try {
        const snapshot = await provider.fetchLatest(target);
        const retrievedAt = this.now();
        status.lastSuccessAt = retrievedAt.toISOString();
        status.lastError = null;
        this.lastSuccessfulFetchAt = retrievedAt;
        this.cache.set(target, {
          snapshot,
          retrievedAt,
          expiresAt: new Date(retrievedAt.getTime() + this.config.cacheTtlSeconds * 1000),
        });
        const warnings =
          index > 0
            ? [
                `Primary provider failed (${errors.map((e) => e.message).join('; ')}). Rates shown come from the fallback provider ${provider.info.name}.`,
              ]
            : [];
        return { snapshot, retrievedAt, servedFromCache: false, usedFallback: index > 0, warnings };
      } catch (err) {
        const appErr = isAppError(err) ? err : new AppError(502, 'UPSTREAM_NETWORK_ERROR', (err as Error)?.message ?? 'Unknown error');
        status.lastError = { at: this.now().toISOString(), code: appErr.code, message: appErr.message };
        // An unsupported base currency is a client problem – don't mask it with the fallback.
        if (appErr.code === 'UNSUPPORTED_CURRENCY' && index === this.providers.length - 1) throw appErr;
        errors.push({ provider: provider.info.id, code: appErr.code, message: appErr.message });
        lastError = appErr;
      }
    }

    // Every provider failed. Serve the last good (expired) snapshot if we have one.
    const cached = this.cache.get(target);
    if (cached) {
      return {
        snapshot: cached.snapshot,
        retrievedAt: cached.retrievedAt,
        servedFromCache: true,
        usedFallback: false,
        allProvidersFailed: true,
        warnings: [
          `All providers failed (${errors.map((e) => e.message).join('; ')}). Showing the last successfully retrieved rates from ${cached.retrievedAt.toISOString()}.`,
        ],
      };
    }
    // A single-provider source (e.g. currencyapi.com) keeps its own specific error: missing key, quota, auth.
    if (this.providers.length === 1 && lastError) throw lastError;
    if (errors.every((e) => e.code === 'UNSUPPORTED_CURRENCY')) {
      throw new AppError(400, 'UNSUPPORTED_CURRENCY', `Target currency ${target} is not supported by any configured provider.`, { errors });
    }
    throw new AppError(502, 'UPSTREAM_UNAVAILABLE', 'Exchange-rate providers are currently unavailable. No cached rates exist yet.', {
      errors,
    });
  }

  private staleness(snapshot: ProviderSnapshot): StalenessResult {
    return evaluateStaleness({
      effectiveDate: snapshot.effectiveDate,
      publishedAt: snapshot.publishedAt,
      now: this.now(),
      staleAfterHours: this.config.staleAfterHours,
      weekendDays: this.config.weekendDays,
      holidays: this.config.holidays,
    });
  }

  /** Provider info for this source (the primary provider of its chain). */
  get info(): ProviderInfo {
    return this.providers[0]!.info;
  }

  /** Which snapshot to fetch for a requested target. */
  private snapshotTarget(target: string): string {
    return this.options.crossFromFunctional ? this.config.targetCurrency : target;
  }

  async getRates(target: string, currencies: string[] | 'all', forceRefresh = false): Promise<RatesResponse> {
    if (this.snapshotTarget(target) !== target) {
      const list = currencies === 'all' ? [this.config.targetCurrency, ...(await this.getSupportedCurrencies(target)).map((c) => c.code)] : currencies;
      return this.getCountryRates(target, list, forceRefresh);
    }
    const result = await this.getSnapshot(target, forceRefresh);
    const { snapshot } = result;
    const wanted = currencies === 'all' ? supportedCodes(snapshot) : currencies.filter((c) => c !== target);
    const rates: NormalisedRate[] = [];
    const unsupported: string[] = [];
    for (const code of wanted) {
      if (snapshot.quotes[code] === undefined) unsupported.push(code);
      else rates.push(normaliseRate(snapshot, code, this.config.rateDecimalPlaces));
    }
    const warnings = [...result.warnings];
    if (unsupported.length) warnings.push(`Not available from ${snapshot.provider.name}: ${unsupported.join(', ')}.`);
    const cached = this.cache.get(target);
    return {
      target,
      provider: snapshot.provider,
      effectiveDate: snapshot.effectiveDate,
      publishedAt: snapshot.publishedAt,
      nextUpdateAt: snapshot.nextUpdateAt,
      retrievedAt: result.retrievedAt.toISOString(),
      lastSuccessfulFetchAt: this.lastSuccessfulFetchAt?.toISOString() ?? null,
      servedFromCache: result.servedFromCache,
      usedFallback: result.usedFallback || snapshot.provider.id !== this.providers[0]!.info.id,
      cacheExpiresAt: cached?.expiresAt.toISOString() ?? null,
      staleness: this.staleness(snapshot),
      rates,
      unsupported,
      warnings,
      disclaimer: REFERENCE_RATE_DISCLAIMER,
    };
  }

  /**
   * Rates for an ERP country table with base `base` (e.g. SAR), cross-calculated from the SAME snapshot
   * of the company's functional currency (one provider call serves every country, so all country tables
   * are mutually consistent). Rate = units of `base` per 1 unit of the foreign currency.
   */
  async getCountryRates(base: string, currencies: string[], forceRefresh = false): Promise<RatesResponse & { via: string }> {
    const via = this.config.targetCurrency;
    const result = await this.getSnapshot(via, forceRefresh);
    const { snapshot } = result;
    if (base !== snapshot.base && snapshot.quotes[base] === undefined) {
      throw new AppError(400, 'UNSUPPORTED_CURRENCY', `Base currency ${base} is not available from ${snapshot.provider.name}.`);
    }
    const rates: NormalisedRate[] = [];
    const unsupported: string[] = [];
    for (const code of [...new Set(currencies)].filter((c) => c !== base)) {
      if (code !== snapshot.base && snapshot.quotes[code] === undefined) unsupported.push(code);
      else rates.push(rebaseRate(snapshot, code, base, this.config.rateDecimalPlaces));
    }
    const warnings = [...result.warnings];
    if (unsupported.length) warnings.push(`Not available from ${snapshot.provider.name}: ${unsupported.join(', ')}.`);
    const cached = this.cache.get(via);
    return {
      target: base,
      via,
      provider: snapshot.provider,
      effectiveDate: snapshot.effectiveDate,
      publishedAt: snapshot.publishedAt,
      nextUpdateAt: snapshot.nextUpdateAt,
      retrievedAt: result.retrievedAt.toISOString(),
      lastSuccessfulFetchAt: this.lastSuccessfulFetchAt?.toISOString() ?? null,
      servedFromCache: result.servedFromCache,
      usedFallback: result.usedFallback || snapshot.provider.id !== this.providers[0]!.info.id,
      cacheExpiresAt: cached?.expiresAt.toISOString() ?? null,
      staleness: this.staleness(snapshot),
      rates,
      unsupported,
      warnings,
      disclaimer: REFERENCE_RATE_DISCLAIMER,
    };
  }

  /**
   * The provider's rates for the day BEFORE `effectiveDate`, re-based to `base` – used as the "previous rate"
   * for deviation checks when nothing has been issued yet for a currency pair. Returns null when no configured
   * provider supplies history. Dated snapshots never change, so they are cached for the life of the process.
   */
  async getPreviousDayRates(
    base: string,
    currencies: string[],
    effectiveDate: string,
  ): Promise<{ effectiveDate: string; source: string; rates: Record<string, string> } | null> {
    const provider = this.providers.find((p) => p.info.supportsHistory && p.fetchHistorical);
    if (!provider?.fetchHistorical) return null;
    const date = new Date(Date.parse(`${effectiveDate}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const via = this.config.targetCurrency;
    const key = `${provider.info.id}:${via}:${date}`;
    let p = this.historyCache.get(key);
    if (!p) {
      p = provider.fetchHistorical(via, date);
      this.historyCache.set(key, p);
      p.catch(() => this.historyCache.delete(key));
    }
    const snapshot = await p;
    const rates: Record<string, string> = {};
    for (const code of currencies) {
      try {
        rates[code] = rebaseRate(snapshot, code, base, this.config.rateDecimalPlaces).rate;
      } catch {
        /* currency missing from that day's snapshot – no previous rate for it */
      }
    }
    return { effectiveDate: snapshot.effectiveDate, source: provider.info.name, rates };
  }

  async getSupportedCurrencies(target: string): Promise<{ code: string; name: string }[]> {
    const { snapshot } = await this.getSnapshot(this.snapshotTarget(target));
    const codes = [...new Set([snapshot.base, ...supportedCodes(snapshot)])].filter((c) => c !== target).sort();
    return codes.map((code) => ({ code, name: normaliseRate(snapshot, code, 2).currencyName }));
  }

  async convert(target: string, from: string, to: string, amount: Decimal): Promise<
    ConversionResult & { effectiveDate: string; provider: ProviderInfo; retrievedAt: string; disclaimer: string }
  > {
    const { snapshot, retrievedAt } = await this.getSnapshot(this.snapshotTarget(target));
    return {
      ...convert(snapshot, from, to, amount, this.config.rateDecimalPlaces),
      effectiveDate: snapshot.effectiveDate,
      provider: snapshot.provider,
      retrievedAt: retrievedAt.toISOString(),
      disclaimer: REFERENCE_RATE_DISCLAIMER,
    };
  }

  /** Daily history for one currency – only from a provider that supports dated snapshots. */
  async getHistory(target: string, currency: string, days: number) {
    const provider = this.providers.find((p) => p.info.supportsHistory && p.fetchHistorical);
    if (!provider || !provider.fetchHistorical) {
      throw new AppError(501, 'HISTORY_NOT_SUPPORTED', 'None of the configured providers supply reliable historical rates.');
    }
    const maxDays = provider.info.maxHistoryDays;
    if (maxDays !== undefined && days > maxDays) {
      throw new AppError(
        501,
        'HISTORY_LIMITED',
        maxDays === 0
          ? `The history chart is turned off for ${provider.info.name} in this POC: every day of history costs one request of the monthly quota.`
          : `${provider.info.name} history is limited to ${maxDays} days in this POC to protect the request quota.`,
      );
    }
    const today = this.now();
    const dates: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
      dates.push(new Date(today.getTime() - i * 86_400_000).toISOString().slice(0, 10));
    }
    const settled = await Promise.allSettled(dates.map((d) => provider.fetchHistorical!(target, d)));
    const points: { date: string; effectiveDate: string; rate: string; inverseRate: string }[] = [];
    const missing: { date: string; reason: string }[] = [];
    settled.forEach((r, i) => {
      const date = dates[i]!;
      if (r.status === 'fulfilled') {
        try {
          const n = normaliseRate(r.value, currency, this.config.rateDecimalPlaces);
          points.push({ date, effectiveDate: r.value.effectiveDate, rate: n.rate, inverseRate: n.inverseRate });
        } catch (e) {
          missing.push({ date, reason: (e as Error).message });
        }
      } else {
        missing.push({ date, reason: (r.reason as Error)?.message ?? 'Unavailable' });
      }
    });
    return {
      target,
      currency,
      provider: provider.info,
      points,
      missing,
      note:
        provider.info.id === this.providers[0]!.info.id
          ? null
          : `History comes from ${provider.info.name} because the primary provider does not offer historical data on its free tier. Values may differ slightly from the primary provider's.`,
      disclaimer: REFERENCE_RATE_DISCLAIMER,
    };
  }

  getStatus() {
    const entries = [...this.cache.entries()].map(([target, e]) => ({
      target,
      providerId: e.snapshot.provider.id,
      effectiveDate: e.snapshot.effectiveDate,
      retrievedAt: e.retrievedAt.toISOString(),
      expiresAt: e.expiresAt.toISOString(),
      expired: this.now() >= e.expiresAt,
      staleness: this.staleness(e.snapshot),
    }));
    const primary = this.providerStatus.get(this.providers[0]!.info.id)!;
    return {
      healthy: primary.lastError === null || entries.length > 0,
      serverTime: this.now().toISOString(),
      lastSuccessfulFetchAt: this.lastSuccessfulFetchAt?.toISOString() ?? null,
      providers: [...this.providerStatus.values()].map((s) => ({
        ...s,
        info: this.providers.find((p) => p.info.id === s.id)!.info,
      })),
      cache: entries,
      settings: {
        targetCurrency: this.config.targetCurrency,
        defaultCurrencies: this.config.defaultCurrencies,
        cacheTtlSeconds: this.config.cacheTtlSeconds,
        minRefreshIntervalSeconds: this.config.minRefreshIntervalSeconds,
        staleAfterHours: this.config.staleAfterHours,
        rateDecimalPlaces: this.config.rateDecimalPlaces,
        weekendDays: this.config.weekendDays,
        holidays: this.config.holidays,
        maxDeviationPercent: this.config.maxDeviationPercent,
      },
      disclaimer: REFERENCE_RATE_DISCLAIMER,
    };
  }
}
