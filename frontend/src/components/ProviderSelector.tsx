import type { ProviderOption, ProviderView } from '../types/api';
import { cx } from '../lib/format';
import { Badge } from './ui';

const TAGS: Record<string, string> = { 'exchangerate-api': 'Existing', 'currencyapi-com': 'New', oanda: 'New' };

/** Segmented control at the top of the dashboard: one provider, or all of them side by side. */
export function ProviderSelector({ value, options, onChange, oandaRateType, onOandaRateTypeChange }: {
  value: ProviderView;
  options: ProviderOption[];
  onChange: (v: ProviderView) => void;
  oandaRateType: string | null;
  onOandaRateTypeChange: (t: string) => void;
}) {
  const items: { id: ProviderView; label: string; hint: string; option?: ProviderOption }[] = [
    ...options.map((o) => ({ id: o.id as ProviderView, label: `${o.label} (${TAGS[o.id] ?? 'New'})`, hint: o.description, option: o })),
    { id: 'compare', label: 'Compare All Providers', hint: 'Shows every provider side by side with the % difference from ExchangeRate-API. Read-only.' },
  ];
  const current = items.find((i) => i.id === value);
  const notConfigured = current?.option && !current.option.configured ? current.option : null;
  const oanda = options.find((o) => o.id === 'oanda');
  const showRateType = (value === 'oanda' || value === 'compare') && oanda?.rateTypes;
  const activeType = oanda?.rateTypes?.find((t) => t.id === (oandaRateType ?? oanda.defaultRateType));

  return (
    <section className="rounded-xl border border-slate-200 bg-white px-5 py-3 shadow-sm" aria-labelledby="provider-heading">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <h2 id="provider-heading" className="text-base font-semibold text-slate-900">
            Exchange rate provider
          </h2>
          <p className="text-sm text-slate-500">Used by the overview, converter and status below. Compare all providers before choosing one for Zybo.</p>
        </div>
        <div role="radiogroup" aria-label="Exchange rate provider" className="inline-flex flex-wrap rounded-lg bg-slate-100 p-1">
          {items.map((i) => (
            <button
              key={i.id}
              type="button"
              role="radio"
              aria-checked={value === i.id}
              title={i.hint}
              onClick={() => onChange(i.id)}
              className={cx(
                'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition',
                value === i.id ? 'bg-white text-teal-800 shadow-sm' : 'text-slate-600 hover:text-slate-900',
              )}
            >
              {i.label}
              {i.option && !i.option.configured && <Badge tone="warning">Key needed</Badge>}
            </button>
          ))}
        </div>
      </div>

      {showRateType && oanda?.rateTypes && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-100 pt-2">
          <span className="text-sm font-medium text-slate-700">OANDA rate type</span>
          <div role="radiogroup" aria-label="OANDA rate type" className="inline-flex rounded-lg bg-slate-100 p-1">
            {oanda.rateTypes.map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={(oandaRateType ?? oanda.defaultRateType) === t.id}
                title={t.description}
                onClick={() => onOandaRateTypeChange(t.id)}
                className={cx(
                  'rounded-md px-2.5 py-1 text-xs font-medium transition',
                  (oandaRateType ?? oanda.defaultRateType) === t.id ? 'bg-white text-teal-800 shadow-sm' : 'text-slate-600 hover:text-slate-900',
                )}
              >
                {t.label.replace('Daily average ', '')}
              </button>
            ))}
          </div>
          <span className="text-xs text-slate-500">
            {activeType?.description} Only what you view changes here. The ERP and the daily update use the server setting (
            {oanda.defaultRateType}).
          </span>
        </div>
      )}

      {!showRateType && <p className="mt-1 text-xs text-slate-500">{current?.hint}</p>}
      {notConfigured && (
        <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-inset ring-amber-200">
          {notConfigured.label} is not set up yet. {notConfigured.setupHint}
        </p>
      )}
    </section>
  );
}
