import { existsSync } from 'node:fs';
import path from 'node:path';

/** Load backend/.env if present (Node's built-in loader – no dotenv dependency). */
const envFile = path.resolve(process.cwd(), '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

export interface AppConfig {
  port: number;
  corsOrigin: string;
  targetCurrency: string;
  defaultCurrencies: string[];
  /** Foreign currencies in the ERP (Zybo) branch exchange-rate tables – independent of the overview selection. */
  erpCurrencies: string[];
  primaryProvider: string;
  fallbackProvider: string | null;
  openErApiBaseUrl: string;
  currencyApiBaseUrl: string;
  requestTimeoutMs: number;
  cacheTtlSeconds: number;
  minRefreshIntervalSeconds: number;
  staleAfterHours: number;
  weekendDays: number[];
  holidays: string[];
  rateDecimalPlaces: number;
  maxDeviationPercent: number;
  /** currencyapi.com – optional second provider for comparison. The key never leaves the backend. */
  currencyApiCom: {
    apiKey: string | null;
    baseUrl: string;
    /** Longer cache than the free provider: the free plan allows only 300 requests per month. */
    cacheTtlSeconds: number;
    minRefreshIntervalSeconds: number;
  };
  /** OANDA Exchange Rates API – optional third provider. The key never leaves the backend. */
  oanda: {
    apiKey: string | null;
    /** Base URL of OANDA's rates API (v1), no trailing slash. */
    baseUrl: string;
    /** Which OANDA daily-average rate the ERP and the daily update use. The dashboard can preview the others. */
    rateType: 'midpoint' | 'bid' | 'ask';
    /** Quote currencies requested per call (OANDA charges per quote). 'all' = every currency OANDA offers. */
    quoteCurrencies: string[] | 'all';
    cacheTtlSeconds: number;
    minRefreshIntervalSeconds: number;
    /** Longest history chart allowed for OANDA; each day is one request. 0 turns the chart off. */
    historyMaxDays: number;
    /** Optional PEM file with an extra CA to trust (company firewall that re-signs HTTPS). Certificate checking stays on. */
    caCertFile: string | null;
  };
  /** Compare Both: |difference| up to `alignedPercent` is "Aligned", up to `reviewPercent` "Minor difference", above that "Large difference". */
  compare: { alignedPercent: number; reviewPercent: number };
  /** The ONE user allowed to edit ERP rates (POC sign-in; production would use Entra ID). */
  erpEditor: { name: string; passcode: string | null };
  /** In-app daily scheduler (POC option A). */
  dailyFetch: {
    enabled: boolean;
    /** Local time HH:MM in `timeZone`. */
    time: string;
    timeZone: string;
    retryMinutes: number;
    maxAttempts: number;
    /** Rate providers the daily job prepares ERP rates for (ids from services/rateSources.ts). */
    providers: string[];
  };
}

type Env = Record<string, string | undefined>;

function intVar(env: Env, name: string, def: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid ${name}="${raw}" – expected an integer between ${min} and ${max}`);
  }
  return n;
}

function numVar(env: Env, name: string, def: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`Invalid ${name}="${raw}" – expected a number between ${min} and ${max}`);
  }
  return n;
}

function listVar(env: Env, name: string, def: string[]): string[] {
  const raw = env[name];
  if (raw === undefined) return def;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function currencyVar(value: string, name: string): string {
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new Error(`Invalid currency code in ${name}: "${value}"`);
  return code;
}

/** Matches the currency list on Zybo's Branches Exchange Rate screen (its duplicate non-ISO "YEN" row maps to JPY), plus AED. */
const ERP_DEFAULT_CURRENCIES = [
  'AED', 'AUD', 'BHD', 'BND', 'CHF', 'CNY', 'DKK', 'EUR', 'GBP', 'HKD', 'IDR', 'INR', 'JPY', 'KWD', 'MAD', 'NOK', 'NZD', 'OMR', 'QAR', 'SAR', 'SEK', 'SGD', 'THB', 'USD', 'ZAR',
];

export function loadConfig(env: Env = process.env): AppConfig {
  const holidays = listVar(env, 'HOLIDAYS', []);
  for (const h of holidays) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(h)) throw new Error(`Invalid HOLIDAYS entry "${h}" – use YYYY-MM-DD`);
  }
  const weekendDays = listVar(env, 'WEEKEND_DAYS', ['0', '6']).map((d) => {
    const n = Number(d);
    if (!Number.isInteger(n) || n < 0 || n > 6) throw new Error(`Invalid WEEKEND_DAYS entry "${d}"`);
    return n;
  });
  const fallback = (env.FALLBACK_PROVIDER ?? 'currency-api').trim();

  const targetCurrency = currencyVar(env.TARGET_CURRENCY ?? 'AED', 'TARGET_CURRENCY');
  const defaultCurrencies = listVar(env, 'DEFAULT_CURRENCIES', ['USD', 'EUR', 'GBP', 'INR', 'SAR', 'CNY']).map((c) =>
    currencyVar(c, 'DEFAULT_CURRENCIES'),
  );
  const erpCurrencies = listVar(env, 'ERP_CURRENCIES', ERP_DEFAULT_CURRENCIES).map((c) => currencyVar(c, 'ERP_CURRENCIES'));

  return {
    port: intVar(env, 'PORT', 4000, 1, 65535),
    corsOrigin: env.CORS_ORIGIN?.trim() || 'http://localhost:5173',
    targetCurrency,
    defaultCurrencies,
    erpCurrencies,
    primaryProvider: (env.PRIMARY_PROVIDER ?? 'open-er-api').trim(),
    fallbackProvider: fallback === '' ? null : fallback,
    openErApiBaseUrl: (env.OPEN_ER_API_BASE_URL ?? 'https://open.er-api.com/v6').replace(/\/+$/, ''),
    currencyApiBaseUrl: (env.CURRENCY_API_BASE_URL ?? 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api').replace(
      /\/+$/,
      '',
    ),
    requestTimeoutMs: intVar(env, 'REQUEST_TIMEOUT_MS', 8000, 500, 60000),
    cacheTtlSeconds: intVar(env, 'CACHE_TTL_SECONDS', 600, 0, 86400),
    minRefreshIntervalSeconds: intVar(env, 'MIN_REFRESH_INTERVAL_SECONDS', 60, 0, 3600),
    staleAfterHours: intVar(env, 'STALE_AFTER_HOURS', 48, 1, 24 * 30),
    weekendDays,
    holidays,
    rateDecimalPlaces: intVar(env, 'RATE_DECIMAL_PLACES', 8, 2, 12),
    maxDeviationPercent: numVar(env, 'MAX_DEVIATION_PERCENT', 5, 0.01, 100),
    currencyApiCom: {
      apiKey: env.CURRENCYAPI_COM_API_KEY?.trim() || null,
      baseUrl: (env.CURRENCYAPI_COM_BASE_URL ?? 'https://api.currencyapi.com/v3').replace(/\/+$/, ''),
      cacheTtlSeconds: intVar(env, 'CURRENCYAPI_COM_CACHE_TTL_SECONDS', 14400, 0, 86400 * 7),
      minRefreshIntervalSeconds: intVar(env, 'CURRENCYAPI_COM_MIN_REFRESH_INTERVAL_SECONDS', 900, 0, 86400),
    },
    oanda: {
      apiKey: env.OANDA_API_KEY?.trim() || null,
      baseUrl: (env.OANDA_BASE_URL ?? 'https://www.oanda.com/rates/api/v1').replace(/\/+$/, ''),
      rateType: oandaRateTypeVar(env.OANDA_RATE_TYPE ?? 'midpoint'),
      quoteCurrencies: oandaQuotes(env.OANDA_QUOTE_CURRENCIES, [...new Set([...erpCurrencies, ...defaultCurrencies, targetCurrency])]),
      cacheTtlSeconds: intVar(env, 'OANDA_CACHE_TTL_SECONDS', 14400, 0, 86400 * 7),
      minRefreshIntervalSeconds: intVar(env, 'OANDA_MIN_REFRESH_INTERVAL_SECONDS', 900, 0, 86400),
      historyMaxDays: intVar(env, 'OANDA_HISTORY_MAX_DAYS', 7, 0, 31),
      caCertFile: env.OANDA_CA_CERT_FILE?.trim() || null,
    },
    compare: {
      alignedPercent: numVar(env, 'COMPARE_ALIGNED_PERCENT', 0.5, 0, 100),
      reviewPercent: numVar(env, 'COMPARE_REVIEW_PERCENT', 2, 0, 100),
    },
    erpEditor: {
      name: env.ERP_EDITOR_NAME?.trim() || 'Finance Manager',
      passcode: env.ERP_EDITOR_PASSCODE?.trim() || null,
    },
    dailyFetch: {
      providers: listVar(env, 'DAILY_FETCH_PROVIDERS', ['exchangerate-api', 'currencyapi-com', 'oanda']),
      enabled: boolVar(env, 'DAILY_FETCH_ENABLED', true),
      time: timeVar(env.DAILY_FETCH_TIME ?? '08:00'),
      timeZone: zoneVar(env.DAILY_FETCH_TIMEZONE ?? 'Asia/Dubai'),
      retryMinutes: intVar(env, 'DAILY_FETCH_RETRY_MINUTES', 15, 1, 240),
      maxAttempts: intVar(env, 'DAILY_FETCH_MAX_ATTEMPTS', 8, 1, 50),
    },
  };
}

function boolVar(env: Env, name: string, def: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return def;
  if (['true', '1', 'yes'].includes(raw)) return true;
  if (['false', '0', 'no'].includes(raw)) return false;
  throw new Error(`Invalid ${name}="${env[name]}" – expected true or false`);
}

function timeVar(value: string): string {
  const v = value.trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`Invalid DAILY_FETCH_TIME="${value}" – use HH:MM (24-hour)`);
  return `${m[1]!.padStart(2, '0')}:${m[2]}`;
}

function zoneVar(value: string): string {
  const v = value.trim();
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: v });
  } catch {
    throw new Error(`Invalid DAILY_FETCH_TIMEZONE="${value}" – use an IANA zone such as Asia/Dubai`);
  }
  return v;
}


function oandaRateTypeVar(value: string): 'midpoint' | 'bid' | 'ask' {
  const v = value.trim().toLowerCase();
  if (v !== 'midpoint' && v !== 'bid' && v !== 'ask') throw new Error(`Invalid OANDA_RATE_TYPE="${value}" – use midpoint, bid or ask`);
  return v;
}

function oandaQuotes(raw: string | undefined, def: string[]): string[] | 'all' {
  if (raw === undefined || raw.trim() === '') return def;
  if (raw.trim().toLowerCase() === 'all') return 'all';
  return raw
    .split(',')
    .map((c) => currencyVar(c, 'OANDA_QUOTE_CURRENCIES'))
    .filter((c, i, a) => a.indexOf(c) === i);
}
