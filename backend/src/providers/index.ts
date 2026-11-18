import type { AppConfig } from '../config.js';
import { CurrencyApiComProvider } from './currencyApiComProvider.js';
import { CurrencyApiProvider } from './currencyApiProvider.js';
import { OandaProvider, type OandaRateType } from './oandaProvider.js';
import { OpenErApiProvider } from './openErApiProvider.js';
import type { ExchangeRateProvider } from './types.js';

/**
 * Provider registry. To add a provider (e.g. Open Exchange Rates or a bank feed),
 * implement ExchangeRateProvider and register it here – nothing else changes.
 */
export function createProvider(id: string, config: AppConfig): ExchangeRateProvider {
  switch (id) {
    case 'open-er-api':
      return new OpenErApiProvider(config.openErApiBaseUrl, config.requestTimeoutMs);
    case 'currency-api':
      return new CurrencyApiProvider(config.currencyApiBaseUrl, config.requestTimeoutMs);
    case 'currencyapi-com':
      return new CurrencyApiComProvider(config.currencyApiCom.baseUrl, config.currencyApiCom.apiKey, config.requestTimeoutMs);
    case 'oanda':
      return createOandaProvider(config, config.oanda.rateType);
    default:
      throw new Error(`Unknown exchange-rate provider "${id}". Available: open-er-api, currency-api, currencyapi-com, oanda`);
  }
}

/** OANDA for one rate type (midpoint / bid / ask). Several can exist side by side; each has its own cache upstream. */
export function createOandaProvider(config: AppConfig, rateType: OandaRateType): OandaProvider {
  const o = config.oanda;
  return new OandaProvider({
    baseUrl: o.baseUrl,
    apiKey: o.apiKey,
    timeoutMs: config.requestTimeoutMs,
    rateType,
    quoteCurrencies: o.quoteCurrencies,
    historyMaxDays: o.historyMaxDays,
    caCertFile: o.caCertFile,
  });
}

/** Ordered list: primary first, then the optional fallback. */
export function createProviderChain(config: AppConfig): ExchangeRateProvider[] {
  const chain = [createProvider(config.primaryProvider, config)];
  if (config.fallbackProvider && config.fallbackProvider !== config.primaryProvider) {
    chain.push(createProvider(config.fallbackProvider, config));
  }
  return chain;
}

export type { ExchangeRateProvider, ProviderInfo, ProviderSnapshot } from './types.js';
