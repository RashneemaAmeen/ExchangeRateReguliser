import type { AppConfig } from '../config.js';
import type { ErpCountry } from '../lib/countries.js';
import type { AutoUpdateResult, EffectiveRateService } from './effectiveRateService.js';
import type { RateSource } from './rateSources.js';

/**
 * Automatic update of one country's effective rates from one provider:
 * re-based rates from the provider's single functional-currency snapshot, validated and applied by
 * EffectiveRateService (manual overrides are left untouched). Used by the scheduler and "Run update now".
 */
export async function autoUpdateCountry(
  deps: { source: RateSource; effective: EffectiveRateService; config: AppConfig },
  country: ErpCountry,
): Promise<AutoUpdateResult & { effectiveDate: string }> {
  const { source, effective, config } = deps;
  const currencies = config.erpCurrencies.filter((c) => c !== country.baseCurrency);
  const data = await source.rates.getCountryRates(country.baseCurrency, currencies);

  // Previous-day rates are only needed as the deviation baseline for pairs that have no automatic rate yet.
  let previousDay: { effectiveDate: string; rates: Record<string, string> } | null = null;
  const notes: string[] = [];
  if (effective.needsBaseline(source.id, country.code, currencies)) {
    try {
      previousDay = await source.rates.getPreviousDayRates(country.baseCurrency, currencies, data.effectiveDate);
    } catch (e) {
      notes.push(`Previous-day rates unavailable (${(e as Error).message}); first rates are applied without a deviation check.`);
    }
  }

  const result = effective.applyAutoUpdate({
    provider: { id: source.id, label: source.label },
    country,
    rates: data.rates,
    effectiveDate: data.effectiveDate,
    retrievedAt: data.retrievedAt,
    staleness: data.staleness,
    rateLabel: data.provider.rateLabel,
    source: `${data.provider.name} [${data.provider.rateLabel}${data.via !== country.baseCurrency ? `, cross via ${data.via}` : ''}]`,
    previousDay,
  });
  if (data.unsupported.length) notes.push(`Not available from ${data.provider.name}: ${data.unsupported.join(', ')}.`);
  return { ...result, messages: [...result.messages, ...notes], effectiveDate: data.effectiveDate };
}
