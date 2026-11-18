/** Shapes returned by the backend API (kept in sync with backend/src). */

export interface ProviderInfo {
  id: string;
  name: string;
  website: string;
  attribution: string;
  rateType: 'reference';
  /** Human-readable rate type, e.g. "Reference (mid-market)" or "Daily average midpoint (OANDA)". */
  rateLabel: string;
  /** MID = midpoint; BID / ASK = one side of the spread (not comparable with a midpoint). */
  rateClass: 'MID' | 'BID' | 'ASK';
  updateFrequency: string;
  supportsHistory: boolean;
  notes: string;
}

export type StalenessStatus = 'fresh' | 'delayed' | 'stale';

export interface Staleness {
  status: StalenessStatus;
  ageHours: number;
  missingBusinessDays: string[];
  nonPublishingDays: string[];
  message: string;
}

export interface ExchangeRate {
  currencyCode: string;
  currencyName: string;
  /** Units of target per 1 unit of currencyCode. */
  rate: string;
  /** Units of currencyCode per 1 unit of target (as published). */
  inverseRate: string;
  direction: string;
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
  staleness: Staleness;
  rates: ExchangeRate[];
  unsupported: string[];
  warnings: string[];
  disclaimer: string;
}

export interface CurrencyOption {
  code: string;
  name: string;
}

export interface ConversionResponse {
  from: string;
  to: string;
  amount: string;
  result: string;
  rate: string;
  inverseRate: string;
  via: string;
  resultDecimalPlaces: number;
  effectiveDate: string;
  provider: ProviderInfo;
  retrievedAt: string;
  disclaimer: string;
}

export interface HistoryResponse {
  target: string;
  currency: string;
  provider: ProviderInfo;
  points: { date: string; effectiveDate: string; rate: string; inverseRate: string }[];
  missing: { date: string; reason: string }[];
  note: string | null;
  disclaimer: string;
}

export interface ProviderStatus {
  id: string;
  name: string;
  role: 'primary' | 'fallback';
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: { at: string; code: string; message: string } | null;
  info: ProviderInfo;
}

export interface StatusResponse {
  healthy: boolean;
  serverTime: string;
  lastSuccessfulFetchAt: string | null;
  providers: ProviderStatus[];
  settings: {
    targetCurrency: string;
    defaultCurrencies: string[];
    cacheTtlSeconds: number;
    minRefreshIntervalSeconds: number;
    staleAfterHours: number;
    rateDecimalPlaces: number;
    maxDeviationPercent: number;
  };
}


/** Rate providers the backend can serve. */
export type ProviderId = 'exchangerate-api' | 'currencyapi-com' | 'oanda';
/** Dashboard selection: one provider, or all of them side by side. */
export type ProviderView = ProviderId | 'compare';

export interface RateTypeOption {
  id: string;
  label: string;
  description: string;
}

export interface ProviderOption {
  id: ProviderId;
  label: string;
  description: string;
  configured: boolean;
  setupHint: string | null;
  /** Rate types the dashboard can preview (OANDA); null when a provider has only one. */
  rateTypes: RateTypeOption[] | null;
  defaultRateType: string | null;
}

export interface ProvidersResponse {
  default: ProviderId;
  providers: ProviderOption[];
}

export type DifferenceStatus = 'ALIGNED' | 'MINOR_DIFFERENCE' | 'LARGE_DIFFERENCE' | 'MISSING' | 'UNAVAILABLE' | 'NO_REFERENCE';

export interface ComparisonSide {
  id: ProviderId;
  label: string;
  /** The provider the % differences are measured against (ExchangeRate-API). */
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
  stalenessStatus: StalenessStatus | null;
  warnings: string[];
}

export interface RowDifference {
  percent: string | null;
  direction: 'HIGHER' | 'LOWER' | 'EQUAL' | null;
  status: DifferenceStatus;
}

export interface ComparisonRow {
  currencyCode: string;
  currencyName: string;
  rates: Record<string, string | null>;
  differences: Record<string, RowDifference>;
}

export interface ComparisonResponse {
  target: string;
  referenceProvider: ProviderId;
  providers: ComparisonSide[];
  effectiveDatesMatch: boolean | null;
  rateTypesMatch: boolean | null;
  warnings: { kind: 'DATES' | 'RATE_TYPES'; message: string }[];
  thresholds: { alignedPercent: number; reviewPercent: number };
  formula: string;
  direction: string;
  rows: ComparisonRow[];
}

export interface ErpCountry {
  code: string;
  name: string;
  baseCurrency: string;
}

export type RateType = 'AUTOMATIC' | 'MANUAL_OVERRIDE';

/** One effective ERP rate (what Zybo would hold – simulated). */
export interface EffectiveRate {
  providerId: ProviderId;
  providerName: string;
  countryCode: string;
  countryName: string;
  baseCurrency: string;
  currencyCode: string;
  currencyName: string;
  /** Rate type of the provider's rate, e.g. "Reference (mid-market)". */
  rateLabel: string;
  rate: string | null;
  rateType: RateType;
  effectiveDate: string | null;
  source: string;
  updatedAt: string | null;
  updatedBy: string | null;
  autoRate: string | null;
  autoEffectiveDate: string | null;
  latestApi: { rate: string; effectiveDate: string; retrievedAt: string; deviationPercent: string | null } | null;
  override: { rate: string; previousRate: string | null; reason: string; by: string; at: string } | null;
  held: { apiRate: string; effectiveDate: string; deviationPercent: string | null; reason: string; at: string } | null;
  changePercent: string | null;
  warnings: string[];
  historyCount: number;
}

export interface ErpListResponse {
  notice: string;
  branchNotice: string;
  functionalCurrency: string;
  erpCurrencies: string[];
  maxDeviationPercent: number;
  providers: ProviderOption[];
  provider: { id: ProviderId; label: string };
  countries: ErpCountry[];
  defaultCountry: string;
  editor: { configured: boolean; name: string; signedIn: boolean };
  countrySummary: { countryCode: string; total: number; overrides: number; held: number }[];
  rates: EffectiveRate[];
}

export interface RateHistoryEntry {
  id: string;
  at: string;
  kind: 'AUTO_UPDATE' | 'MANUAL_OVERRIDE' | 'OVERRIDE_REMOVED' | 'API_RATE_ACCEPTED';
  rate: string;
  previousRate: string | null;
  effectiveDate: string;
  user: string;
  reason: string | null;
  deviationPercent: string | null;
  source: string;
}

export interface AuditEvent {
  id: string;
  at: string;
  user: string;
  action: 'RATE_UPDATED' | 'UPDATE_HELD' | 'MANUAL_OVERRIDE' | 'OVERRIDE_REMOVED' | 'API_RATE_ACCEPTED' | 'SIMULATION_RESET';
  providerId: string;
  countryCode: string | null;
  currencyCode: string | null;
  previousRate: string | null;
  newRate: string | null;
  reason: string | null;
  detail: string | null;
}

export interface EditorSessionInfo {
  editorConfigured: boolean;
  editorName: string;
  session: { name: string; expiresAt: string } | null;
}

export interface CountryRunResult {
  providerId: ProviderId;
  providerName: string;
  countryCode: string;
  countryName: string;
  baseCurrency: string;
  updated: number;
  unchanged: number;
  held: number;
  keptOverride: number;
  error: string | null;
}

export interface ScheduleRun {
  trigger: 'schedule' | 'retry' | 'manual' | 'startup';
  startedAt: string;
  finishedAt: string | null;
  localDate: string;
  attempt: number;
  status: 'running' | 'success' | 'partial' | 'retrying' | 'failed';
  message: string;
  providers: { id: ProviderId; label: string; ok: boolean; effectiveDate: string | null; error: string | null }[];
  countries: CountryRunResult[];
}

export interface ScheduleState {
  enabled: boolean;
  time: string;
  timeZone: string;
  retryMinutes: number;
  maxAttempts: number;
  providers: { id: ProviderId; label: string }[];
  running: boolean;
  nextRunAt: string | null;
  lastRun: ScheduleRun | null;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}
