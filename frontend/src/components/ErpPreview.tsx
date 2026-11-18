import { useEffect, useState, type ReactNode } from 'react';
import { erpApi } from '../services/api';
import type { AuditEvent, EffectiveRate, ProviderId, ProviderOption, RateHistoryEntry } from '../types/api';
import type { useErpPreview } from '../hooks/useErpPreview';
import { cx, formatDateTime, groupDigits } from '../lib/format';
import { providerTone } from '../lib/providers';
import { Alert, Badge, Button, Card, Field, inputClass } from './ui';
import { DailyUpdatePanel } from './DailyUpdatePanel';

function currencyLabel(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'currency' }).of(code) ?? code;
  } catch {
    return code;
  }
}

const signed = (p: string | null) => (p === null ? null : `${Number(p) > 0 ? '+' : ''}${p}%`);

export type ErpState = ReturnType<typeof useErpPreview>;

/**
 * ERP Integration page body. State (provider, country) and data (the useErpPreview hook) are owned by App,
 * so switching pages keeps the selection and does not refetch.
 */
export function ErpPreview({ erp, provider, onProviderChange, providerOptions, countryCode, onCountryChange }: {
  erp: ErpState;
  provider: ProviderId;
  onProviderChange: (p: ProviderId) => void;
  providerOptions: ProviderOption[];
  countryCode: string | null;
  onCountryChange: (code: string) => void;
}) {
  const setCountryCode = onCountryChange;
  const data = erp.data;
  const selectedCountry = countryCode ?? data?.defaultCountry ?? null;
  const country = data?.countries.find((c) => c.code === selectedCountry);
  const providerLabel = providerOptions.find((o) => o.id === provider)?.label ?? provider;

  const [editFor, setEditFor] = useState<EffectiveRate | null>(null);
  const [historyFor, setHistoryFor] = useState<EffectiveRate | null>(null);
  const [showAudit, setShowAudit] = useState(false);
  const [sql, setSql] = useState<string | null>(null);

  const rates = data?.rates ?? [];
  const counts = {
    automatic: rates.filter((r) => r.rate && r.rateType === 'AUTOMATIC').length,
    manual: rates.filter((r) => r.rateType === 'MANUAL_OVERRIDE').length,
    held: rates.filter((r) => r.held).length,
  };

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          Branches Exchange Rate <Badge tone="violet">Simulation</Badge>
        </span>
      }
      subtitle="Rates update automatically and apply to all branches of each country. Read-only except for the rate editor. Nothing is written to Zybo."
      actions={
        <>
          <div className="mr-2 flex items-center gap-2" role="radiogroup" aria-label="Effective ERP rate provider">
            <span className="text-xs font-medium text-slate-500">Effective rates from</span>
            <div className="inline-flex rounded-lg bg-slate-100 p-1">
              {providerOptions.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  role="radio"
                  aria-checked={provider === o.id}
                  onClick={() => onProviderChange(o.id)}
                  className={cx(
                    'rounded-md px-2.5 py-1 text-xs font-medium transition',
                    provider === o.id ? 'bg-white text-teal-800 shadow-sm' : 'text-slate-600 hover:text-slate-900',
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          <Button size="sm" onClick={async () => setSql(await erpApi.sql(provider, selectedCountry ?? undefined))} disabled={!selectedCountry}>
            View SQL preview
          </Button>
          <Button size="sm" onClick={() => setShowAudit((v) => !v)} aria-expanded={showAudit}>
            {showAudit ? 'Hide audit log' : 'Audit log'}
          </Button>
          {erp.isEditor && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void erp.reset()}
              loading={erp.busy === 'reset'}
              title="Removes all overrides and history in this simulation, then reloads fresh rates"
            >
              Clear simulation
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 xl:grid-cols-2">
          <EditorBar erp={erp} />
          <DailyUpdatePanel schedule={erp.schedule} canRun={erp.isEditor} onRunNow={() => void erp.runNow()} busy={erp.busy === 'runNow'} compact />
        </div>

        {providerOptions.find((o) => o.id === provider && !o.configured) && (
          <Alert tone="warning" title={`${providerLabel} is not set up`}>
            {providerOptions.find((o) => o.id === provider)?.setupHint} No effective rates exist for it until a key is added and the next
            automatic update runs.
          </Alert>
        )}

        {erp.error && (
          <Alert tone="danger" onDismiss={erp.clearError}>
            {erp.error}
          </Alert>
        )}
        {erp.message && (
          <Alert tone="success" onDismiss={erp.clearMessage}>
            {erp.message}
          </Alert>
        )}

        <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
          <nav aria-label="Countries" className="rounded-lg border border-slate-200 bg-slate-50">
            <p className="border-b border-slate-200 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Country</p>
            <ul className="py-1">
              {(data?.countries ?? []).map((c) => {
                const active = c.code === selectedCountry;
                const s = data?.countrySummary.find((x) => x.countryCode === c.code);
                return (
                  <li key={c.code}>
                    <button
                      type="button"
                      onClick={() => setCountryCode(c.code)}
                      aria-current={active ? 'true' : undefined}
                      className={cx(
                        'flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition',
                        active ? 'bg-teal-700 text-white' : 'text-slate-700 hover:bg-white',
                      )}
                    >
                      <span
                        className={cx(
                          'w-7 shrink-0 rounded px-1 py-0.5 text-center font-mono text-[10px] font-semibold',
                          active ? 'bg-teal-900/40 text-teal-50' : 'bg-white text-slate-500 ring-1 ring-slate-200',
                        )}
                      >
                        {c.code}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium leading-tight">{c.name}</span>
                        <span className={cx('block font-mono text-xs', active ? 'text-teal-100' : 'text-slate-500')}>{c.baseCurrency}</span>
                      </span>
                      {s && (s.overrides > 0 || s.held > 0) && (
                        <span className="flex shrink-0 flex-col items-end gap-0.5 text-[10px] font-semibold">
                          {s.overrides > 0 && (
                            <span className={cx('rounded-full px-1.5', active ? 'bg-amber-300 text-amber-950' : 'bg-amber-100 text-amber-800')}>
                              {s.overrides} manual
                            </span>
                          )}
                          {s.held > 0 && (
                            <span className={cx('rounded-full px-1.5', active ? 'bg-rose-200 text-rose-950' : 'bg-rose-100 text-rose-800')}>
                              {s.held} held
                            </span>
                          )}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="min-w-0 space-y-4">
            {country ? (
              <>
                <div className="flex flex-wrap items-end justify-between gap-4 rounded-lg border border-teal-200 bg-teal-50 px-4 py-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-teal-800">
                      {country.name} · Base currency · Rates from {providerLabel}
                    </p>
                    <p className="mt-0.5 flex items-baseline gap-2">
                      <span className="font-mono text-3xl font-bold text-teal-900">{country.baseCurrency}</span>
                      <span className="text-sm text-teal-900">{currencyLabel(country.baseCurrency)}</span>
                    </p>
                    <p className="mt-1 text-xs text-teal-800">
                      Exchange rate = {country.baseCurrency} per 1 unit of foreign currency (e.g. 1 USD = ? {country.baseCurrency}).{' '}
                      {data?.branchNotice ?? 'Effective exchange rates apply to all branches under the selected country.'}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs">
                    <Badge tone="success">Automatic: {counts.automatic}</Badge>
                    <Badge tone="warning">Manual override: {counts.manual}</Badge>
                    {counts.held > 0 && <Badge tone="danger">Held: {counts.held}</Badge>}
                  </div>
                </div>


                {showAudit && <AuditPanel provider={provider} country={country.code} refreshKey={data} />}

                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <table className="min-w-full divide-y divide-slate-200 text-sm">
                    <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-3 py-3">Code</th>
                        <th className="px-3 py-3">Currency</th>
                        <th className="px-3 py-3 text-right">Exchange Rate ({country.baseCurrency})</th>
                        <th className="px-3 py-3">Effective Date</th>
                        <th className="px-3 py-3">Source</th>
                        <th className="px-3 py-3">Rate Type</th>
                        <th className="px-3 py-3">Last Updated</th>
                        <th className="px-3 py-3 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 bg-white">
                      {rates.length === 0 && (
                        <tr>
                          <td colSpan={8} className="px-4 py-10 text-center text-slate-500">
                            No rates yet for {country.name} from {providerLabel}. They appear after the next automatic update
                            {erp.isEditor ? ' – or use “Run update now”.' : '.'}
                          </td>
                        </tr>
                      )}
                      {rates.map((r) => (
                        <RateRow
                          key={r.currencyCode}
                          r={r}
                          isEditor={erp.isEditor}
                          busy={erp.busy}
                          onEdit={() => setEditFor(r)}
                          onResume={() => void erp.resume(r.currencyCode)}
                          onAccept={() => void erp.accept(r.currencyCode)}
                          onHistory={() => setHistoryFor(r)}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <p className="px-4 py-10 text-center text-sm text-slate-500">Loading countries…</p>
            )}
          </div>
        </div>
      </div>

      {editFor && (
        <EditDialog
          record={editFor}
          busy={erp.busy === `override:${editFor.currencyCode}`}
          onCancel={() => setEditFor(null)}
          onSubmit={async (rate, reason) => {
            if (await erp.override(editFor.currencyCode, rate, reason)) setEditFor(null);
          }}
        />
      )}
      {historyFor && <HistoryDialog record={historyFor} provider={provider} onClose={() => setHistoryFor(null)} />}
      {sql !== null && <SqlDialog sql={sql} onClose={() => setSql(null)} />}
    </Card>
  );
}

function EditorBar({ erp }: { erp: ReturnType<typeof useErpPreview> }) {
  const [open, setOpen] = useState(false);
  const [passcode, setPasscode] = useState('');
  const info = erp.session;
  if (!info) return null;

  if (info.session) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-950">
        <span>
          Signed in as <strong>{info.session.name}</strong> (rate editor). You can edit individual rates; every change is recorded in the audit log.
        </span>
        <Button size="sm" onClick={() => void erp.logout()}>
          Sign out
        </Button>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm text-slate-600">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          <strong className="text-slate-900">Read-only view.</strong> Rates update automatically.{' '}
          {info.editorConfigured
            ? `Only the rate editor (${info.editorName}) can change a rate.`
            : 'Manual editing is turned off: no rate-editor passcode is set on the server.'}
        </span>
        {info.editorConfigured && !open && (
          <Button size="sm" onClick={() => setOpen(true)}>
            Sign in as rate editor
          </Button>
        )}
      </div>
      {open && (
        <form
          className="mt-2 flex flex-wrap items-end gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await erp.login(passcode)) {
              setPasscode('');
              setOpen(false);
            }
          }}
        >
          <Field label={`Passcode for ${info.editorName}`}>
            <input
              id="editor-passcode"
              type="password"
              autoComplete="current-password"
              className={inputClass}
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              autoFocus
            />
          </Field>
          <Button type="submit" variant="primary" loading={erp.busy === 'login'} disabled={!passcode}>
            Sign in
          </Button>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
        </form>
      )}
    </div>
  );
}

function RateRow({ r, isEditor, busy, onEdit, onResume, onAccept, onHistory }: {
  r: EffectiveRate;
  isEditor: boolean;
  busy: string | null;
  onEdit: () => void;
  onResume: () => void;
  onAccept: () => void;
  onHistory: () => void;
}) {
  const manual = r.rateType === 'MANUAL_OVERRIDE';
  return (
    <tr className={cx('align-top', manual && 'bg-amber-50/60', r.held && !manual && 'bg-rose-50/40')}>
      <td className="whitespace-nowrap px-3 py-3 font-mono font-semibold">{r.currencyCode}</td>
      <td className="px-3 py-3 text-slate-700">{r.currencyName}</td>
      <td className="tabular whitespace-nowrap px-3 py-3 text-right font-mono" title={r.rate ? `1 ${r.currencyCode} = ${r.rate} ${r.baseCurrency}` : undefined}>
        <span className={cx(manual && 'font-semibold text-amber-800')}>{r.rate ? groupDigits(r.rate) : '—'}</span>
        {manual && r.override && <div className="mt-0.5 text-xs text-slate-500">was {r.override.previousRate ?? '—'}</div>}
        {manual && r.latestApi && <div className="text-xs text-slate-500">API now {r.latestApi.rate}</div>}
        {!manual && r.changePercent && !r.held && (
          <div className="mt-0.5 text-xs text-slate-500" title="Change at the last update vs the rate before">
            {signed(r.changePercent)} vs previous
          </div>
        )}
        {r.held && (
          <div className="mt-1 max-w-56 whitespace-normal rounded bg-rose-50 px-2 py-1 text-left text-xs text-rose-800 ring-1 ring-rose-200">
            Update held: API {r.held.apiRate} ({signed(r.held.deviationPercent)}). {r.held.reason}
          </div>
        )}
      </td>
      <td className="whitespace-nowrap px-3 py-3">{r.effectiveDate ?? '—'}</td>
      <td className="px-3 py-3 text-xs text-slate-600" title={r.source}>
        <Badge tone={providerTone(r.providerId)}>{r.providerName}</Badge>
        <div className="mt-1">
          {manual ? 'Manual rate' : r.rateLabel}
          {!manual && r.source.includes('cross via') && <span className="text-slate-400"> · cross via AED</span>}
        </div>
      </td>
      <td className="px-3 py-3">
        {manual ? <Badge tone="warning">Manual override</Badge> : <Badge tone="success">Automatic</Badge>}
        {manual && r.override && (
          <div className="mt-1 max-w-40 text-xs text-slate-600">
            “{r.override.reason}”<div className="text-slate-500">by {r.override.by}</div>
          </div>
        )}
        {r.warnings.map((w) => (
          <div key={w} className="mt-1 max-w-56 text-xs text-amber-800">
            ⚠ {w}
          </div>
        ))}
      </td>
      <td className="w-32 px-3 py-3 text-xs text-slate-600">
        {r.updatedAt ? formatDateTime(r.updatedAt) : '—'}
        {r.updatedBy && <div className="text-slate-500">{r.updatedBy}</div>}
      </td>
      <td className="w-36 px-3 py-3 text-right">
        <div className="flex flex-col items-stretch gap-1 [&>button]:whitespace-normal">
          {isEditor && r.held && !manual && (
            <Button size="sm" variant="success" onClick={onAccept} loading={busy === `accept:${r.currencyCode}`} title="Make the held API rate effective">
              Accept API rate
            </Button>
          )}
          {isEditor && (
            <Button size="sm" onClick={onEdit} title="Set a manual rate for this currency only">
              Edit
            </Button>
          )}
          {isEditor && manual && (
            <Button size="sm" variant="primary" onClick={onResume} loading={busy === `resume:${r.currencyCode}`} title="Remove the override and go back to automatic updates">
              Resume Auto Update
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onHistory} title="Rate history">
            History
          </Button>
        </div>
      </td>
    </tr>
  );
}

function AuditPanel({ provider, country, refreshKey }: { provider: ProviderId; country: string; refreshKey: unknown }) {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  useEffect(() => {
    let alive = true;
    erpApi
      .audit(provider, country)
      .then((r) => alive && setEvents(r.events))
      .catch(() => alive && setEvents([]));
    return () => {
      alive = false;
    };
  }, [provider, country, refreshKey]);

  const label: Record<AuditEvent['action'], string> = {
    RATE_UPDATED: 'Updated automatically',
    UPDATE_HELD: 'Automatic update held',
    MANUAL_OVERRIDE: 'Manual override',
    OVERRIDE_REMOVED: 'Auto update resumed',
    API_RATE_ACCEPTED: 'Held API rate accepted',
    SIMULATION_RESET: 'Simulation cleared',
  };
  return (
    <div className="rounded-lg border border-slate-200">
      <p className="border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
        Audit log · latest first
      </p>
      <div className="max-h-72 overflow-auto">
        {events === null ? (
          <p className="px-3 py-4 text-sm text-slate-500">Loading…</p>
        ) : events.length === 0 ? (
          <p className="px-3 py-4 text-sm text-slate-500">No changes recorded yet.</p>
        ) : (
          <table className="min-w-full text-xs">
            <tbody className="divide-y divide-slate-100">
              {events.map((e) => (
                <tr key={e.id} className="align-top">
                  <td className="whitespace-nowrap px-3 py-2 text-slate-500">{formatDateTime(e.at)}</td>
                  <td className="px-3 py-2 font-medium text-slate-900">{label[e.action]}</td>
                  <td className="px-3 py-2 font-mono">{e.currencyCode ?? '—'}</td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-slate-600">
                    {e.previousRate ?? '—'} → {e.newRate ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-slate-600">{e.user}</td>
                  <td className="px-3 py-2 text-slate-600">{e.reason ? `“${e.reason}”` : e.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <h3 className="font-semibold text-slate-900">{title}</h3>
          <button className="text-slate-400 hover:text-slate-700" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function EditDialog({ record, busy, onCancel, onSubmit }: {
  record: EffectiveRate;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (rate: string, reason: string) => void;
}) {
  const [rate, setRate] = useState(record.rate ?? record.latestApi?.rate ?? '');
  const [reason, setReason] = useState('');
  const valid = /^\d{1,15}(\.\d{1,12})?$/.test(rate.trim()) && !/^0+(\.0+)?$/.test(rate.trim()) && reason.trim().length >= 3;
  return (
    <Modal title={`Edit rate – ${record.currencyCode} → ${record.baseCurrency} (${record.countryName})`} onClose={onCancel}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onSubmit(rate.trim(), reason.trim());
        }}
      >
        <Alert tone="warning">
          This changes {record.currencyCode} only, for all {record.countryName} branches. It becomes a manual override: automatic updates
          will not change it until you choose Resume Auto Update. Current rate:{' '}
          <strong className="font-mono">{record.rate ?? '—'}</strong>
          {record.latestApi && (
            <>
              {' '}
              · latest API rate: <strong className="font-mono">{record.latestApi.rate}</strong>
            </>
          )}
        </Alert>
        <Field label={`New rate (1 ${record.currencyCode} = ? ${record.baseCurrency})`}>
          <input id="edit-rate" className={inputClass + ' font-mono'} value={rate} onChange={(e) => setRate(e.target.value)} inputMode="decimal" autoFocus />
        </Field>
        <Field label="Reason" hint="Recorded in the audit log, e.g. “Bank contract rate – Emirates NBD deal #123”">
          <input id="edit-reason" className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onCancel}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!valid} loading={busy}>
            Save manual rate
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function HistoryDialog({ record, provider, onClose }: { record: EffectiveRate; provider: ProviderId; onClose: () => void }) {
  const [rows, setRows] = useState<RateHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    erpApi
      .history({ provider, country: record.countryCode, currency: record.currencyCode })
      .then((r) => setRows(r.history))
      .catch((e: Error) => setError(e.message));
  }, [provider, record.countryCode, record.currencyCode]);
  const kind: Record<RateHistoryEntry['kind'], string> = {
    AUTO_UPDATE: 'Automatic',
    MANUAL_OVERRIDE: 'Manual override',
    OVERRIDE_REMOVED: 'Auto update resumed',
    API_RATE_ACCEPTED: 'Held rate accepted',
  };
  return (
    <Modal title={`History – ${record.currencyCode} → ${record.baseCurrency} (${record.countryName}, ${record.providerName})`} onClose={onClose}>
      {error && <Alert tone="danger">{error}</Alert>}
      {!rows && !error && <p className="text-sm text-slate-500">Loading…</p>}
      {rows && (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-2 py-2">When</th>
                <th className="px-2 py-2">Change</th>
                <th className="px-2 py-2 text-right">Previous</th>
                <th className="px-2 py-2 text-right">New</th>
                <th className="px-2 py-2">Effective</th>
                <th className="px-2 py-2">By</th>
                <th className="px-2 py-2">Reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((h) => (
                <tr key={h.id} className="align-top">
                  <td className="whitespace-nowrap px-2 py-2 text-xs text-slate-600">{formatDateTime(h.at)}</td>
                  <td className="px-2 py-2">{kind[h.kind]}</td>
                  <td className="px-2 py-2 text-right font-mono text-slate-500">{h.previousRate ?? '—'}</td>
                  <td className="px-2 py-2 text-right font-mono">{h.rate || '—'}</td>
                  <td className="whitespace-nowrap px-2 py-2">{h.effectiveDate}</td>
                  <td className="px-2 py-2 text-slate-600">{h.user}</td>
                  <td className="px-2 py-2 text-slate-600">{h.reason ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

function SqlDialog({ sql, onClose }: { sql: string; onClose: () => void }) {
  return (
    <Modal title="SQL Server mapping preview (not executed)" onClose={onClose}>
      <pre className="max-h-[65vh] overflow-auto rounded-lg bg-slate-900 p-4 font-mono text-xs leading-relaxed text-slate-100">{sql}</pre>
      <div className="mt-3 flex justify-end gap-2">
        <Button onClick={() => void navigator.clipboard?.writeText(sql)}>Copy</Button>
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      </div>
    </Modal>
  );
}
