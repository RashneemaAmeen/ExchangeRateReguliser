import type { ReactNode } from 'react';
import type { ApiError } from '../services/api';
import type { RatesResponse, StatusResponse } from '../types/api';
import { formatDate, formatDateTime, relativeTime } from '../lib/format';
import { Alert, Badge, Card } from './ui';

const stalenessTone = { fresh: 'success', delayed: 'warning', stale: 'danger' } as const;
const stalenessLabel = { fresh: 'Current', delayed: 'Delayed (weekend/holiday)', stale: 'Stale' } as const;

function Item({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-1 text-sm font-medium text-slate-900">{children}</dd>
      {hint && <dd className="mt-0.5 text-xs text-slate-500">{hint}</dd>}
    </div>
  );
}

/** Shows where the rates came from, how old they are, and any problems. */
export function StatusPanel({ data, status, error }: { data: RatesResponse | null; status: StatusResponse | null; error: ApiError | null }) {
  const lastSuccess = data?.lastSuccessfulFetchAt ?? status?.lastSuccessfulFetchAt ?? null;
  return (
    <div className="space-y-3">
      {error && (
        <Alert tone="danger" title={error.code === 'BACKEND_UNREACHABLE' ? 'Backend not reachable' : 'Could not load exchange rates'}>
          <p>{error.message}</p>
          {data ? (
            <p className="mt-1">The rates below are from the previous successful load ({formatDateTime(data.retrievedAt)}).</p>
          ) : (
            <p className="mt-1">
              Last successful fetch: <strong>{lastSuccess ? `${formatDateTime(lastSuccess)} (${relativeTime(lastSuccess)})` : 'none yet'}</strong>
            </p>
          )}
          {status?.providers.some((p) => p.lastError) && (
            <ul className="mt-2 list-disc pl-5 text-xs">
              {status.providers
                .filter((p) => p.lastError)
                .map((p) => (
                  <li key={p.id}>
                    {p.name} ({p.role}): {p.lastError!.message}
                  </li>
                ))}
            </ul>
          )}
        </Alert>
      )}

      {data && data.staleness.status !== 'fresh' && (
        <Alert tone={data.staleness.status === 'stale' ? 'danger' : 'warning'} title={data.staleness.status === 'stale' ? 'Stale rates' : 'Publication delayed'}>
          {data.staleness.message}
        </Alert>
      )}

      {data?.warnings.map((w) => (
        <Alert key={w} tone="warning">
          {w}
        </Alert>
      ))}

      {data && (
        <Card>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-3 xl:grid-cols-6">
            <Item label="Data source" hint={data.provider.updateFrequency}>
              <a href={data.provider.website} target="_blank" rel="noreferrer" className="text-teal-700 hover:underline">
                {data.provider.name}
              </a>
              {data.usedFallback && (
                <span className="ml-1.5 align-middle">
                  <Badge tone="warning">fallback</Badge>
                </span>
              )}
            </Item>
            <Item label="Rate type" hint="Not a bank or transaction rate">
              <Badge tone={data.provider.rateClass === 'MID' ? 'info' : 'warning'}>{data.provider.rateLabel}</Badge>
            </Item>
            <Item label="Effective date" hint={`${data.staleness.ageHours} h since publication`}>
              {formatDate(data.effectiveDate)}
            </Item>
            <Item label="Rate status">
              <Badge tone={stalenessTone[data.staleness.status]}>{stalenessLabel[data.staleness.status]}</Badge>
            </Item>
            <Item label="Provider published" hint={data.nextUpdateAt ? `Next update ≈ ${formatDateTime(data.nextUpdateAt)}` : undefined}>
              {data.publishedAt ? formatDateTime(data.publishedAt) : 'Date only (no timestamp)'}
            </Item>
            <Item
              label="Last successful retrieval"
              hint={data.servedFromCache ? `Served from server cache · ${relativeTime(data.retrievedAt)}` : `Fresh from provider · ${relativeTime(data.retrievedAt)}`}
            >
              {formatDateTime(lastSuccess ?? data.retrievedAt)}
            </Item>
          </dl>
        </Card>
      )}
    </div>
  );
}
