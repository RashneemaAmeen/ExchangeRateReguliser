import type { AppConfig } from '../config.js';
import { Decimal } from '../lib/decimal.js';
import { AppError, isAppError } from '../lib/errors.js';
import { OANDA_RATE_TYPES, isOandaRateType, type OandaRateType } from '../providers/oandaProvider.js';
import type { ExchangeRateProvider } from '../providers/types.js';
import { RateService, type RatesResponse } from './rateService.js';

/**
 * A "rate source" is what the user picks in the dashboard: one provider chain with its own cache,
 * quota guard and status. Add a new source here (plus its provider adapter) to make it selectable.
 */
export interface RateType {
  id: string;
  label: string;
  description: string;
}

export interface RateSource {
  id: string;
  label: string;
  description: string;
  /** False when required settings (e.g. an API key) are missing – the source is listed but explains why it fails. */
  configured: boolean;
  setupHint: string | null;
  /** The default rate service: what the ERP, the daily update and an unqualified request use. */
  rates: RateService;
  /** Rate types the dashboard can preview for this source (OANDA). Absent when a source has only one. */
  rateTypes?: RateType[];
  defaultRateType?: string;
  /** Service for a previewed rate type; the default one when omitted. Previews never touch effective ERP rates. */
  ratesFor(rateType?: string | null): RateService;
}

export const DEFAULT_SOURCE_ID = 'exchangerate-api';
export const COMPARE_IDS = ['exchangerate-api', 'currencyapi-com', 'oanda'] as const;

export class RateSourceRegistry {
  private readonly sources = new Map<string, RateSource>();

  add(source: RateSource): void {
    this.sources.set(source.id, source);
  }

  list(): RateSource[] {
    return [...this.sources.values()];
  }

  ids(): string[] {
    return [...this.sources.keys()];
  }

  get(id: string | undefined | null): RateSource {
    const key = (id ?? DEFAULT_SOURCE_ID).trim() || DEFAULT_SOURCE_ID;
    const s = this.sources.get(key);
    if (!s) {
      throw new AppError(400, 'VALIDATION_ERROR', `Unknown rate provider "${key}". Available: ${this.ids().join(', ')}.`);
    }
    return s;
  }

  get default(): RateSource {
    return this.get(DEFAULT_SOURCE_ID);
  }

  /** Public description for the frontend – never includes keys or URLs with credentials. */
  describe() {
    return this.list().map((s) => ({
      id: s.id,
      label: s.label,
      description: s.description,
      configured: s.configured,
      setupHint: s.setupHint,
      rateTypes: s.rateTypes ?? null,
      defaultRateType: s.defaultRateType ?? null,
    }));
  }
}

/** A single-rate-type source. */
function simpleSource(s: Omit<RateSource, 'ratesFor'>): RateSource {
  return { ...s, ratesFor: () => s.rates };
}

export function createRateSources(
  config: AppConfig,
  chains: {
    exchangeRateApi: ExchangeRateProvider[];
    currencyApiCom: ExchangeRateProvider[];
    /** OANDA chain for one rate type. A fixed array (tests) is used for every type. */
    oanda: ExchangeRateProvider[] | ((rateType: OandaRateType) => ExchangeRateProvider[]);
  },
  now?: () => Date,
): RateSourceRegistry {
  const reg = new RateSourceRegistry();
  reg.add(
    simpleSource({
      id: 'exchangerate-api',
      label: 'ExchangeRate-API',
      description: 'Existing integration (Open Access, free, no key). Backup: community currency API.',
      configured: true,
      setupHint: null,
      rates: new RateService(chains.exchangeRateApi, config, now),
    }),
  );

  const cKey = config.currencyApiCom.apiKey;
  reg.add(
    simpleSource({
      id: 'currencyapi-com',
      label: 'currencyapi.com',
      description: 'Second integration for comparison. API key held on the server. Free plan: 300 requests/month.',
      configured: Boolean(cKey),
      setupHint: cKey ? null : 'Add CURRENCYAPI_COM_API_KEY to backend/.env and restart the backend.',
      rates: new RateService(
        chains.currencyApiCom,
        {
          ...config,
          cacheTtlSeconds: config.currencyApiCom.cacheTtlSeconds,
          minRefreshIntervalSeconds: config.currencyApiCom.minRefreshIntervalSeconds,
        },
        now,
        { crossFromFunctional: true },
      ),
    }),
  );

  // OANDA: one RateService per rate type, created on first use. Each has its own cache, so previewing bid or ask
  // never changes what the default (ERP) service holds. One AED snapshot serves every target, as for currencyapi.com.
  const oandaKey = config.oanda.apiKey;
  const oandaServices = new Map<OandaRateType, RateService>();
  const oandaFor = (t: OandaRateType): RateService => {
    let s = oandaServices.get(t);
    if (!s) {
      s = new RateService(
        typeof chains.oanda === 'function' ? chains.oanda(t) : chains.oanda,
        { ...config, cacheTtlSeconds: config.oanda.cacheTtlSeconds, minRefreshIntervalSeconds: config.oanda.minRefreshIntervalSeconds },
        now,
        { crossFromFunctional: true },
      );
      oandaServices.set(t, s);
    }
    return s;
  };
  const oandaDefault = config.oanda.rateType;
  reg.add({
    id: 'oanda',
    label: 'OANDA',
    description: 'Third integration for comparison. Daily average rates from OANDA. API key held on the server; trial or subscription required.',
    configured: Boolean(oandaKey),
    setupHint: oandaKey ? null : 'Add OANDA_API_KEY to backend/.env and restart the backend. See the README for how to get a key.',
    rates: oandaFor(oandaDefault),
    rateTypes: (Object.keys(OANDA_RATE_TYPES) as OandaRateType[]).map((id) => ({ id, label: OANDA_RATE_TYPES[id].label, description: OANDA_RATE_TYPES[id].description })),
    defaultRateType: oandaDefault,
    ratesFor(rateType) {
      if (rateType === undefined || rateType === null || rateType === '') return oandaFor(oandaDefault);
      if (!isOandaRateType(rateType)) {
        throw new AppError(400, 'VALIDATION_ERROR', `Unknown OANDA rate type "${rateType}". Use midpoint, bid or ask.`);
      }
      return oandaFor(rateType);
    },
  });
  return reg;
}

/* ------------------------------------------------------------------------------------------------ */
/* Compare All Providers                                                                             */
/* ------------------------------------------------------------------------------------------------ */

export type DifferenceStatus = 'ALIGNED' | 'MINOR_DIFFERENCE' | 'LARGE_DIFFERENCE' | 'MISSING' | 'UNAVAILABLE' | 'NO_REFERENCE';

export interface ProviderSide {
  id: string;
  label: string;
  /** True for the provider the % differences are measured against (ExchangeRate-API). */
  reference: boolean;
  ok: boolean;
  error: { code: string; message: string } | null;
  effectiveDate: string | null;
  publishedAt: string | null;
  retrievedAt: string | null;
  servedFromCache: boolean;
  usedFallback: boolean;
  providerName: string | null;
  rateLabel: string | null;
  rateClass: 'MID' | 'BID' | 'ASK' | null;
  stalenessStatus: string | null;
  warnings: string[];
}

export interface RowDifference {
  /** ((provider − reference) / reference) × 100, 4 dp, signed. */
  percent: string | null;
  direction: 'HIGHER' | 'LOWER' | 'EQUAL' | null;
  status: DifferenceStatus;
}

export interface ComparisonRow {
  currencyCode: string;
  currencyName: string;
  /** Rate per provider id (null = not available from that provider). */
  rates: Record<string, string | null>;
  /** Difference vs the reference, for every provider except the reference itself. */
  differences: Record<string, RowDifference>;
}

/**
 * Builds the side-by-side table for all providers. Every provider goes through the same path (cross-calculated from the
 * functional-currency snapshot with `rebaseRate`, same decimal places), so direction and precision are identical:
 * rate = units of `target` per 1 unit of the currency. One provider failing never fails the comparison.
 * Read-only: nothing here touches effective ERP rates.
 */
export async function compareSources(
  registry: RateSourceRegistry,
  config: AppConfig,
  target: string,
  currencies: string[],
  forceRefresh = false,
  oandaRateType?: string | null,
) {
  const sources = COMPARE_IDS.map((id) => registry.get(id));
  const refSource = sources[0]!;
  const settled = await Promise.allSettled(
    sources.map((s) => s.ratesFor(s.id === 'oanda' ? oandaRateType : undefined).getCountryRates(target, currencies, forceRefresh)),
  );

  const sides: ProviderSide[] = sources.map((src, i) => {
    const r = settled[i] as PromiseSettledResult<RatesResponse>;
    const base = { id: src.id, label: src.label, reference: src.id === refSource.id };
    if (r.status === 'fulfilled') {
      const d = r.value;
      return {
        ...base,
        ok: true,
        error: null,
        effectiveDate: d.effectiveDate,
        publishedAt: d.publishedAt,
        retrievedAt: d.retrievedAt,
        servedFromCache: d.servedFromCache,
        usedFallback: d.usedFallback,
        providerName: d.provider.name,
        rateLabel: d.provider.rateLabel,
        rateClass: d.provider.rateClass,
        stalenessStatus: d.staleness.status,
        warnings: d.warnings,
      };
    }
    const e = r.reason;
    const info = src.ratesFor(src.id === 'oanda' ? oandaRateType : undefined).info;
    return {
      ...base,
      ok: false,
      error: isAppError(e) ? { code: e.code, message: e.message } : { code: 'UNKNOWN', message: String((e as Error)?.message ?? e) },
      effectiveDate: null,
      publishedAt: null,
      retrievedAt: null,
      servedFromCache: false,
      usedFallback: false,
      providerName: null,
      rateLabel: info.rateLabel,
      rateClass: info.rateClass,
      stalenessStatus: null,
      warnings: [],
    };
  });

  const byId = new Map(
    sources.map((s, i) => {
      const r = settled[i] as PromiseSettledResult<RatesResponse>;
      return [s.id, new Map(r.status === 'fulfilled' ? r.value.rates.map((x) => [x.currencyCode, x]) : [])] as const;
    }),
  );
  const refSide = sides[0]!;

  const rows: ComparisonRow[] = [...new Set(currencies)]
    .filter((c) => c !== target)
    .map((code) => {
      const rates: Record<string, string | null> = {};
      let name = code;
      for (const s of sources) {
        const x = byId.get(s.id)!.get(code);
        rates[s.id] = x?.rate ?? null;
        if (x && name === code) name = x.currencyName;
      }
      const differences: Record<string, RowDifference> = {};
      for (const [i, s] of sources.entries()) {
        if (i === 0) continue;
        const side = sides[i]!;
        const none = { percent: null, direction: null };
        if (!side.ok) differences[s.id] = { ...none, status: 'UNAVAILABLE' };
        else if (!refSide.ok) differences[s.id] = { ...none, status: 'NO_REFERENCE' };
        else if (rates[s.id] === null || rates[refSource.id] === null) differences[s.id] = { ...none, status: 'MISSING' };
        else {
          const ref = new Decimal(rates[refSource.id]!);
          const diff = new Decimal(rates[s.id]!).minus(ref).div(ref).mul(100);
          const abs = diff.abs();
          differences[s.id] = {
            percent: diff.toFixed(4).replace(/^-(0\.0+)$/, '$1'),
            direction: diff.isZero() ? 'EQUAL' : diff.gt(0) ? 'HIGHER' : 'LOWER',
            status: abs.lte(config.compare.alignedPercent) ? 'ALIGNED' : abs.lte(config.compare.reviewPercent) ? 'MINOR_DIFFERENCE' : 'LARGE_DIFFERENCE',
          };
        }
      }
      return { currencyCode: code, currencyName: name, rates, differences };
    });

  const okSides = sides.filter((s) => s.ok);
  const dates = new Set(okSides.map((s) => s.effectiveDate));
  const classes = new Set(okSides.map((s) => s.rateClass));
  const datesMatch = okSides.length < 2 ? null : dates.size === 1;
  const typesMatch = okSides.length < 2 ? null : classes.size === 1;
  const warnings: { kind: 'DATES' | 'RATE_TYPES'; message: string }[] = [];
  if (datesMatch === false) {
    warnings.push({
      kind: 'DATES',
      message:
        `The providers' rates are for different dates (${okSides.map((s) => `${s.label}: ${s.effectiveDate}`).join(', ')}). ` +
        'Part of the difference may be market movement between those dates rather than a disagreement between providers.',
    });
  }
  if (typesMatch === false) {
    warnings.push({
      kind: 'RATE_TYPES',
      message:
        `The providers' rate types are not comparable (${okSides.map((s) => `${s.label}: ${s.rateLabel}`).join(', ')}). ` +
        'A bid or ask rate is one side of the spread and will differ from a mid-market rate even when the data agrees.',
    });
  }
  return {
    target,
    referenceProvider: refSource.id,
    providers: sides,
    effectiveDatesMatch: datesMatch,
    rateTypesMatch: typesMatch,
    warnings,
    thresholds: { alignedPercent: config.compare.alignedPercent, reviewPercent: config.compare.reviewPercent },
    formula: '((provider rate − ExchangeRate-API rate) / ExchangeRate-API rate) × 100',
    direction: `Rates are units of ${target} per 1 unit of the listed currency, ${config.rateDecimalPlaces} decimal places, from every provider.`,
    rows,
  };
}
