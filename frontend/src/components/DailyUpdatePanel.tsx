import { useState } from 'react';
import type { ScheduleState } from '../types/api';
import { cx, formatDateTime } from '../lib/format';
import { Badge, Button } from './ui';

const STATUS: Record<NonNullable<ScheduleState['lastRun']>['status'], { label: string; tone: 'success' | 'warning' | 'danger' | 'info' }> = {
  running: { label: 'Running', tone: 'info' },
  success: { label: 'Completed', tone: 'success' },
  partial: { label: 'Completed with gaps', tone: 'warning' },
  retrying: { label: 'Failed, will retry', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' },
};

const TRIGGER = { schedule: 'scheduled run', retry: 'automatic retry', manual: 'run manually', startup: 'initial load at startup' } as const;

/** The automatic update: when it runs, when it ran, and what it changed. */
export function DailyUpdatePanel({ schedule, canRun, onRunNow, busy, compact = false }: {
  schedule: ScheduleState | null;
  canRun: boolean;
  onRunNow: () => void;
  busy: boolean;
  /** One-line summary with a Details toggle (used on the ERP Integration page). */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!schedule) return null;
  const last = schedule.lastRun;
  const meta = last ? STATUS[last.status] : null;
  const multi = schedule.providers.length > 1;
  if (compact && !open) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-sm">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-slate-600">
          <span className="font-semibold text-slate-900">Automatic update</span>
          <Badge tone={schedule.enabled ? 'success' : 'neutral'}>{schedule.enabled ? `Daily ${schedule.time}` : 'Off'}</Badge>
          {last && meta && (
            <span title={last.message}>
              Last run {formatDateTime(last.finishedAt ?? last.startedAt)} <Badge tone={meta.tone}>{meta.label}</Badge>
            </span>
          )}
          {schedule.nextRunAt && <span>· Next {formatDateTime(schedule.nextRunAt)}</span>}
        </div>
        <div className="flex gap-2">
          {canRun && (
            <Button size="sm" onClick={onRunNow} loading={busy || schedule.running}>
              Run update now
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setOpen(true)} aria-expanded={false}>
            Details
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-900">
            Automatic rate update
            <Badge tone={schedule.enabled ? 'success' : 'neutral'}>{schedule.enabled ? 'On' : 'Off'}</Badge>
          </p>
          {schedule.enabled ? (
            <p className="text-sm text-slate-600">
              Every day at <strong className="text-slate-900">{schedule.time}</strong> ({schedule.timeZone === 'Asia/Dubai' ? 'UAE time' : schedule.timeZone}) the
              latest rates from <strong className="text-slate-900">{schedule.providers.map((p) => p.label).join(' and ')}</strong> are validated and become
              effective for all countries. No approval is needed. Manual overrides are left unchanged.
              {schedule.nextRunAt && (
                <>
                  {' '}
                  Next run: <strong className="text-slate-900">{formatDateTime(schedule.nextRunAt)}</strong>.
                </>
              )}
            </p>
          ) : (
            <p className="text-sm text-slate-600">Turned off (DAILY_FETCH_ENABLED=false).</p>
          )}
          <p className="text-xs text-slate-500">
            A rate that moves more than the deviation limit, or stale source data, is held and the current rate stays. Runs only while the POC
            server is running; if a provider is down it retries every {schedule.retryMinutes} min, up to {schedule.maxAttempts} attempts.
          </p>
        </div>
        <div className="flex gap-2">
          {canRun && (
            <Button size="sm" onClick={onRunNow} loading={busy || schedule.running} title="Fetch and apply rates for all countries now">
              Run update now
            </Button>
          )}
          {compact && (
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)} aria-expanded>
              Hide details
            </Button>
          )}
        </div>
      </div>

      {last && meta && (
        <div className="mt-3 space-y-2 border-t border-slate-200 pt-3">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-slate-500">Last run</span>
            <span className="text-slate-900">{formatDateTime(last.finishedAt ?? last.startedAt)}</span>
            <span className="text-xs text-slate-500">({TRIGGER[last.trigger]}{last.attempt > 1 ? `, attempt ${last.attempt}` : ''})</span>
            <Badge tone={meta.tone}>{meta.label}</Badge>
          </p>
          <p className={cx('text-sm', last.status === 'failed' ? 'text-rose-800' : last.status === 'retrying' ? 'text-amber-800' : 'text-slate-700')}>
            {last.message}
          </p>
          {last.countries.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {last.countries.map((c) => (
                <li
                  key={`${c.providerId}-${c.countryCode}`}
                  title={
                    c.error ??
                    `${c.providerName}: ${c.updated} updated · ${c.unchanged} unchanged · ${c.keptOverride} manual kept · ${c.held} held`
                  }
                  className={cx(
                    'rounded-md px-2 py-0.5 font-mono text-xs ring-1 ring-inset',
                    c.error ? 'bg-rose-50 text-rose-800 ring-rose-200' : c.held ? 'bg-amber-50 text-amber-800 ring-amber-200' : 'bg-white text-slate-700 ring-slate-200',
                  )}
                >
                  {multi && <span className="text-slate-400">{c.providerName.slice(0, 4)} </span>}
                  {c.baseCurrency} {c.error ? '✕' : `↻${c.updated}`}
                  {c.held > 0 && ` ⚠${c.held}`}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
