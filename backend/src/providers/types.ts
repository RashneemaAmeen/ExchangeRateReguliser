/**
 * Provider abstraction. Every exchange-rate source is adapted to this shape so the
 * rest of the backend (and the frontend) never depends on a specific vendor.
 */

export interface ProviderInfo {
  id: string;
  name: string;
  website: string;
  /** Attribution text required/recommended by the provider's terms. */
  attribution: string;
  /** What kind of rate this is. All providers in the POC supply reference rates only. */
  rateType: 'reference';
  /** Human-readable rate type shown to users, e.g. "Reference (mid-market)" or "Daily average midpoint (OANDA)". */
  rateLabel: string;
  /**
   * Comparison class: providers are only directly comparable when this matches. MID = midpoint, BID / ASK = one side
   * of the spread (never comparable with a midpoint).
   */
  rateClass: 'MID' | 'BID' | 'ASK';
  /** Human-readable update cadence – never claim real-time unless true. */
  updateFrequency: string;
  supportsHistory: boolean;
  /** Upper limit for the multi-day history chart (each day may cost one request). Undefined = no limit. */
  maxHistoryDays?: number;
  notes: string;
}

/** Raw provider data, already validated but not yet normalised. */
export interface ProviderSnapshot {
  provider: ProviderInfo;
  /** Currency the quotes are expressed against: quotes[X] = units of X per 1 `base`. */
  base: string;
  /** Raw quotes as received (JSON numbers). Converted to Decimal during normalisation. */
  quotes: Record<string, number>;
  /** Date the rates apply to (YYYY-MM-DD, UTC). */
  effectiveDate: string;
  /** Provider's own publication timestamp, if it supplies one (ISO 8601). */
  publishedAt: string | null;
  /** Provider's announced next update, if any (ISO 8601). */
  nextUpdateAt: string | null;
}

export interface ExchangeRateProvider {
  readonly info: ProviderInfo;
  /** Latest rates with `base` as the quote currency. */
  fetchLatest(base: string): Promise<ProviderSnapshot>;
  /** Rates for a past date. Only implemented when info.supportsHistory is true. */
  fetchHistorical?(base: string, date: string): Promise<ProviderSnapshot>;
}
