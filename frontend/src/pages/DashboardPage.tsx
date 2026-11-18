import { ComparisonTable } from '../components/ComparisonTable';
import { ConverterCard } from '../components/ConverterCard';
import { HistoryPanel } from '../components/HistoryPanel';
import { ProviderSelector } from '../components/ProviderSelector';
import { RatesTable } from '../components/RatesTable';
import { RatesToolbar } from '../components/RatesToolbar';
import { StatusPanel } from '../components/StatusPanel';
import { Card } from '../components/ui';
import type { useComparison } from '../hooks/useComparison';
import type { useExchangeRates } from '../hooks/useExchangeRates';
import type { ProviderId, ProviderOption, ProviderView } from '../types/api';

export interface DashboardProps {
  providerView: ProviderView;
  onProviderViewChange: (v: ProviderView) => void;
  providerOptions: ProviderOption[];
  dataProvider: ProviderId;
  oandaRateType: string | null;
  onOandaRateTypeChange: (t: string) => void;
  target: string;
  onTargetChange: (t: string) => void;
  selected: string[];
  onSelectedChange: (s: string[]) => void;
  defaults: string[];
  search: string;
  onSearchChange: (s: string) => void;
  historyCode: string | null;
  onHistoryCodeChange: (c: string | null) => void;
  rates: ReturnType<typeof useExchangeRates>;
  comparison: ReturnType<typeof useComparison>;
}

/** Page 1 – API Dashboard: provider choice, status, overview / comparison, converter and history. */
export function DashboardPage(p: DashboardProps) {
  const { rates, comparison, target, selected, historyCode } = p;
  const comparing = p.providerView === 'compare';
  const rateType = p.dataProvider === 'oanda' ? (p.oandaRateType ?? undefined) : undefined;
  const add = (code: string) => p.onSelectedChange(selected.includes(code) ? selected : [...selected, code]);
  const remove = (code: string) => {
    p.onSelectedChange(selected.filter((c) => c !== code));
    if (historyCode === code) p.onHistoryCodeChange(null);
  };

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-2.5 text-sm text-sky-900">
        <strong>Reference rates only.</strong>{' '}
        {rates.data?.disclaimer ??
          'Rates are indicative mid-market reference rates, published once per day. They are not bank buy/sell or transaction rates and not real-time.'}{' '}
        For customer invoices and payments, use the rate agreed with your bank.
      </div>

      <ProviderSelector
        value={p.providerView}
        options={p.providerOptions}
        onChange={p.onProviderViewChange}
        oandaRateType={p.oandaRateType}
        onOandaRateTypeChange={p.onOandaRateTypeChange}
      />

      <StatusPanel data={rates.data} status={rates.status} error={rates.error} />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <Card
          title={comparing ? 'Exchange Rate Overview · Compare All Providers' : 'Exchange Rate Overview'}
          subtitle={
            comparing
              ? `Foreign currency → ${target} from all providers. ExchangeRate-API is the reference for the difference.`
              : `Foreign currency → ${target} · ${p.providerOptions.find((o) => o.id === p.dataProvider)?.label ?? p.dataProvider}`
          }
          className="min-w-0"
        >
          <div className="space-y-5">
            <RatesToolbar
              target={target}
              onTargetChange={(t) => {
                p.onTargetChange(t);
                p.onHistoryCodeChange(null);
              }}
              search={p.search}
              onSearchChange={p.onSearchChange}
              available={rates.currencies}
              selected={selected}
              onAdd={add}
              onResetSelection={() => p.onSelectedChange(p.defaults)}
              onShowAll={() => p.onSelectedChange(rates.currencies.map((c) => c.code))}
              onRefresh={() => void (comparing ? comparison.reload() : rates.refresh())}
              onFetchLatest={() => void (comparing ? comparison.refresh() : rates.fetchLatest())}
              loadingAction={comparing ? (comparison.loading === 'refresh' ? 'fetch' : comparison.loading) : rates.loadingAction}
            />
            {comparing ? (
              <ComparisonTable data={comparison.data} loading={comparison.loading !== null} error={comparison.error?.message ?? null} search={p.search} />
            ) : (
              <RatesTable
                rates={rates.data?.rates ?? []}
                target={rates.data?.target ?? target}
                effectiveDate={rates.data?.effectiveDate ?? '—'}
                sourceName={rates.data?.provider.name ?? '—'}
                unsupported={rates.data?.unsupported ?? []}
                search={p.search}
                loading={rates.loading}
                defaults={p.defaults}
                onRemove={remove}
                onHistory={p.onHistoryCodeChange}
                historyCode={historyCode}
              />
            )}
            {comparing ? (
              <p className="text-xs text-slate-500">
                Rates By Exchange Rate API (https://www.exchangerate-api.com) · Exchange rates provided by currencyapi.com · Exchange rates provided by OANDA
              </p>
            ) : (
              rates.data && <p className="text-xs text-slate-500">{rates.data.provider.attribution}</p>
            )}
          </div>
        </Card>

        <div className="space-y-5">
          <ConverterCard target={target} currencies={rates.currencies} provider={p.dataProvider} rateType={rateType} />
          {historyCode && !comparing && (
            <HistoryPanel target={target} currency={historyCode} provider={p.dataProvider} rateType={rateType} onClose={() => p.onHistoryCodeChange(null)} />
          )}
        </div>
      </div>
    </div>
  );
}
