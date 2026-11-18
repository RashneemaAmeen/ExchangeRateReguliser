import { useEffect, useState } from 'react';
import { ApiError, exchangeRateApi } from '../services/api';
import type { HistoryResponse, ProviderId } from '../types/api';
import { formatDate, groupDigits } from '../lib/format';
import { Alert, Badge, Button, Card, Spinner } from './ui';

export function HistoryPanel({ target, currency, provider, rateType, onClose }: { target: string; currency: string; provider: ProviderId; rateType?: string; onClose: () => void }) {
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(7);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    exchangeRateApi
      .getHistory(provider, target, currency, days, rateType)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e instanceof ApiError ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [target, currency, days, provider, rateType]);

  const points = data ? [...data.points].reverse() : [];

  return (
    <Card
      title={`${currency} → ${target} history`}
      subtitle={data ? `Source: ${data.provider.name}` : 'Daily reference rates'}
      actions={
        <>
          {[7, 14, 30].map((d) => (
            <Button key={d} size="sm" variant={d === days ? 'primary' : 'secondary'} onClick={() => setDays(d)}>
              {d} days
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close history">
            ✕
          </Button>
        </>
      }
    >
      {error && <Alert tone="warning" title="History unavailable">{error}</Alert>}
      {!data && !error && (
        <div className="flex justify-center py-6 text-teal-700">
          <Spinner />
        </div>
      )}
      {data && (
        <div className="space-y-3">
          {data.note && <Alert tone="info">{data.note}</Alert>}
          <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-200">
            <table className="min-w-full text-sm">
              <thead className="sticky top-0 bg-slate-50 text-left text-xs font-semibold uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2 text-right">1 {currency} =</th>
                  <th className="px-3 py-2 text-right">Change</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {points.map((p, i) => {
                  const prev = points[i + 1];
                  // Direction indicator only – compare as strings of equal scale, no float maths.
                  const cmp = prev ? p.rate.localeCompare(prev.rate, 'en', { numeric: true }) : 0;
                  return (
                    <tr key={p.date}>
                      <td className="px-3 py-2 text-slate-700">
                        {formatDate(p.date)}
                        {p.effectiveDate !== p.date && <span className="ml-1 text-xs text-slate-400">(data {p.effectiveDate})</span>}
                      </td>
                      <td className="tabular px-3 py-2 text-right font-mono">
                        {groupDigits(p.rate)} {target}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {prev ? (cmp > 0 ? <Badge tone="success">▲</Badge> : cmp < 0 ? <Badge tone="danger">▼</Badge> : <Badge>＝</Badge>) : ''}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {data.missing.length > 0 && (
            <p className="text-xs text-slate-500">
              No data for: {data.missing.map((m) => m.date).join(', ')} (not yet published or unavailable).
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
