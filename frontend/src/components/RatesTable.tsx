import type { ExchangeRate } from '../types/api';
import { cx, groupDigits } from '../lib/format';
import { Badge, Button, Spinner } from './ui';

interface Props {
  rates: ExchangeRate[];
  target: string;
  effectiveDate: string;
  sourceName: string;
  unsupported: string[];
  search: string;
  loading: boolean;
  defaults: string[];
  onRemove: (code: string) => void;
  onHistory: (code: string) => void;
  historyCode: string | null;
}

export function RatesTable(p: Props) {
  const q = p.search.trim().toLowerCase();
  const rows = q ? p.rates.filter((r) => r.currencyCode.toLowerCase().includes(q) || r.currencyName.toLowerCase().includes(q)) : p.rates;

  return (
    <div className="space-y-3">
      {p.unsupported.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
          <span>Not available from this provider:</span>
          {p.unsupported.map((c) => (
            <span key={c} className="inline-flex items-center gap-1">
              <Badge tone="danger">{c}</Badge>
              <button className="text-xs text-slate-400 hover:text-slate-700" onClick={() => p.onRemove(c)} aria-label={`Remove ${c}`}>
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="relative overflow-x-auto rounded-lg border border-slate-200">
        {p.loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/60">
            <Spinner className="h-6 w-6 text-teal-700" />
          </div>
        )}
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Code</th>
              <th className="px-4 py-3">Currency</th>
              <th className="px-4 py-3 text-right">
                Rate <span className="normal-case text-slate-400">(1 unit = {p.target})</span>
              </th>
              <th className="px-4 py-3 text-right">
                Inverse <span className="normal-case text-slate-400">(1 {p.target} =)</span>
              </th>
              <th className="px-4 py-3">Rate date</th>
              <th className="px-4 py-3">Source</th>
              <th className="px-4 py-3 text-right">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-slate-500">
                  {p.rates.length === 0 ? 'No rates loaded.' : `No currencies match “${p.search}”.`}
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.currencyCode} className={cx('hover:bg-slate-50', p.historyCode === r.currencyCode && 'bg-teal-50/60')}>
                <td className="whitespace-nowrap px-4 py-3 font-mono font-semibold text-slate-900">
                  {r.currencyCode}
                  {p.defaults.includes(r.currencyCode) && <span className="ml-1 text-xs font-normal text-slate-400">•</span>}
                </td>
                <td className="px-4 py-3 text-slate-700">{r.currencyName}</td>
                <td className="tabular whitespace-nowrap px-4 py-3 text-right font-mono font-semibold text-slate-900" title={r.direction}>
                  {groupDigits(r.rate)}
                </td>
                <td className="tabular whitespace-nowrap px-4 py-3 text-right font-mono text-slate-500">
                  {groupDigits(r.inverseRate)} {r.currencyCode}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-slate-600">{p.effectiveDate}</td>
                <td className="px-4 py-3 text-xs text-slate-500">{p.sourceName}</td>
                <td className="whitespace-nowrap px-4 py-3 text-right">
                  <Button size="sm" variant="ghost" onClick={() => p.onHistory(r.currencyCode)}>
                    History
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => p.onRemove(r.currencyCode)} aria-label={`Remove ${r.currencyCode}`}>
                    ✕
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">
        Direction: <strong>1 unit of the listed currency = Rate {p.target}</strong>. “Inverse” is the provider’s published quote.
        Rates are rounded half-up for display; calculations on the server use exact decimal arithmetic. • = default currency.
      </p>
    </div>
  );
}
