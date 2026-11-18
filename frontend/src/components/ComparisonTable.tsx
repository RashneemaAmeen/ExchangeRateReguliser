import type { ComparisonResponse, ComparisonRow, ComparisonSide, DifferenceStatus, RowDifference } from '../types/api';
import { cx, formatDateTime, groupDigits } from '../lib/format';
import { providerTone } from '../lib/providers';
import { Alert, Badge, Spinner } from './ui';

const CELL: Record<DifferenceStatus, string> = {
  ALIGNED: 'text-slate-700',
  MINOR_DIFFERENCE: 'bg-amber-50 text-amber-900',
  LARGE_DIFFERENCE: 'bg-rose-50 font-semibold text-rose-800',
  MISSING: 'text-slate-400',
  UNAVAILABLE: 'text-slate-400',
  NO_REFERENCE: 'text-slate-400',
};
const WORD: Record<DifferenceStatus, string> = {
  ALIGNED: 'Aligned',
  MINOR_DIFFERENCE: 'Minor difference',
  LARGE_DIFFERENCE: 'Large difference',
  MISSING: 'Not available from this provider',
  UNAVAILABLE: 'Provider unavailable',
  NO_REFERENCE: 'ExchangeRate-API (the reference) is unavailable',
};

function SideInfo({ side }: { side: ComparisonSide }) {
  return (
    <div className={cx('min-w-0 rounded-lg border px-3 py-2', side.ok ? 'border-slate-200 bg-slate-50' : 'border-rose-200 bg-rose-50')}>
      <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-slate-900">
        <Badge tone={providerTone(side.id)}>{side.label}</Badge>
        {side.reference && <span className="text-xs font-medium text-slate-500">reference</span>}
        {side.ok && side.usedFallback && <Badge tone="warning">backup source</Badge>}
      </p>
      {side.ok ? (
        <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-slate-600">
          <dt>Rate type</dt>
          <dd className="font-medium text-slate-900">{side.rateLabel}</dd>
          <dt>Effective date</dt>
          <dd className="font-medium text-slate-900">{side.effectiveDate}</dd>
          <dt>Published</dt>
          <dd>{side.publishedAt ? formatDateTime(side.publishedAt) : 'Not provided'}</dd>
          <dt>Retrieved</dt>
          <dd>
            {formatDateTime(side.retrievedAt)}
            {side.servedFromCache && <span className="text-slate-400"> · cached</span>}
          </dd>
        </dl>
      ) : (
        <p className="mt-1.5 text-sm text-rose-800">{side.error?.message ?? 'Unavailable.'}</p>
      )}
    </div>
  );
}

function Diff({ d }: { d: RowDifference | undefined }) {
  if (!d || d.percent === null) {
    return (
      <span className="text-slate-400" title={d ? WORD[d.status] : undefined}>
        {d?.status === 'UNAVAILABLE' ? 'n/a' : '—'}
      </span>
    );
  }
  const n = Number(d.percent);
  return (
    <span title={WORD[d.status]} className="whitespace-nowrap">
      <span className="font-mono">
        {n > 0 ? '+' : ''}
        {d.percent}%
      </span>
      <span className="ml-1 text-xs text-slate-500">{d.direction === 'HIGHER' ? 'higher' : d.direction === 'LOWER' ? 'lower' : 'equal'}</span>
    </span>
  );
}

/** Side-by-side table for Compare All Providers. ExchangeRate-API is the reference for the % differences. Read-only. */
export function ComparisonTable({ data, loading, error, search }: {
  data: ComparisonResponse | null;
  loading: boolean;
  error: string | null;
  search: string;
}) {
  if (error) return <Alert tone="danger">{error}</Alert>;
  if (!data) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-slate-500">
        <Spinner /> Loading all providers…
      </div>
    );
  }
  const side = (id: string) => data.providers.find((p) => p.id === id)!;
  const [ref, cur, oan] = [side('exchangerate-api'), side('currencyapi-com'), side('oanda')];
  const q = search.trim().toLowerCase();
  const rows: ComparisonRow[] = data.rows.filter((r) => !q || r.currencyCode.toLowerCase().includes(q) || r.currencyName.toLowerCase().includes(q));
  const th = 'px-3 py-2.5';
  const unavailable = (s: ComparisonSide) => !s.ok;

  return (
    <div className={cx('space-y-3', loading && 'opacity-60')}>
      <div className="grid gap-2.5 lg:grid-cols-3">
        {data.providers.map((p) => (
          <SideInfo key={p.id} side={p} />
        ))}
      </div>

      {data.warnings.map((w) => (
        <Alert key={w.kind} tone="warning" title={w.kind === 'DATES' ? 'Different effective dates' : 'Rate types are not comparable'}>
          {w.message}
        </Alert>
      ))}

      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th className={th}>Code</th>
              <th className={th}>Currency</th>
              <th className={cx(th, 'text-right')}>ExchangeRate-API</th>
              <th className={cx(th, 'text-right')}>currencyapi.com</th>
              <th className={cx(th, 'text-right')}>OANDA</th>
              <th className={cx(th, 'text-right')}>currencyapi.com diff %</th>
              <th className={cx(th, 'text-right')}>OANDA diff %</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                  No currencies match “{search}”.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.currencyCode}>
                <td className="px-3 py-2.5 font-mono font-semibold">{r.currencyCode}</td>
                <td className="px-3 py-2.5 text-slate-700">{r.currencyName}</td>
                {[ref, cur, oan].map((s) => (
                  <td key={s.id} className="tabular px-3 py-2.5 text-right font-mono">
                    {r.rates[s.id] ? groupDigits(r.rates[s.id]!) : <span className="text-slate-400" title={unavailable(s) ? 'Provider unavailable' : 'Not available from this provider'}>{unavailable(s) ? 'n/a' : '—'}</span>}
                  </td>
                ))}
                <td className={cx('tabular px-3 py-2.5 text-right', CELL[r.differences['currencyapi-com']?.status ?? 'MISSING'])}>
                  <Diff d={r.differences['currencyapi-com']} />
                </td>
                <td className={cx('tabular px-3 py-2.5 text-right', CELL[r.differences.oanda?.status ?? 'MISSING'])}>
                  <Diff d={r.differences.oanda} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">
        {data.direction} Difference = {data.formula}. Normal within ±{data.thresholds.alignedPercent}%, amber up to ±{data.thresholds.reviewPercent}%, red above.
        Comparing never changes ERP rates.
      </p>
    </div>
  );
}
