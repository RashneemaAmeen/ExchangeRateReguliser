import { useState } from 'react';
import type { CurrencyOption } from '../types/api';
import { Button, Field, inputClass } from './ui';

export const TARGET_OPTIONS = ['AED', 'USD', 'EUR', 'GBP', 'SAR', 'INR'];

interface Props {
  target: string;
  onTargetChange: (code: string) => void;
  search: string;
  onSearchChange: (s: string) => void;
  available: CurrencyOption[];
  selected: string[];
  onAdd: (code: string) => void;
  onResetSelection: () => void;
  onShowAll: () => void;
  onRefresh: () => void;
  onFetchLatest: () => void;
  loadingAction: 'initial' | 'refresh' | 'fetch' | null;
}

export function RatesToolbar(p: Props) {
  const [toAdd, setToAdd] = useState('');
  const [manual, setManual] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);
  const addable = p.available.filter((c) => !p.selected.includes(c.code) && c.code !== p.target);

  const addManual = () => {
    const code = manual.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) {
      setManualError('Enter a 3-letter ISO code, e.g. JPY');
      return;
    }
    setManualError(null);
    p.onAdd(code); // unsupported codes are reported by the backend
    setManual('');
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Field label="Target (base) currency" hint="Rates are shown as 1 unit of foreign currency = X target">
          <select className={inputClass} value={p.target} onChange={(e) => p.onTargetChange(e.target.value)}>
            {TARGET_OPTIONS.map((c) => (
              <option key={c} value={c}>
                {c}
                {c === 'AED' ? ' (ERP base)' : ''}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Search / filter">
          <input
            className={inputClass}
            placeholder="Code or name, e.g. rupee"
            value={p.search}
            onChange={(e) => p.onSearchChange(e.target.value)}
            type="search"
          />
        </Field>

        <Field label="Add currency from list">
          <div className="flex gap-2">
            <select className={inputClass} value={toAdd} onChange={(e) => setToAdd(e.target.value)}>
              <option value="">Select…</option>
              {addable.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} – {c.name}
                </option>
              ))}
            </select>
            <Button
              disabled={!toAdd}
              onClick={() => {
                p.onAdd(toAdd);
                setToAdd('');
              }}
            >
              Add
            </Button>
          </div>
        </Field>

        <Field label="Add by ISO code" hint={manualError ?? undefined}>
          <div className="flex gap-2">
            <input
              className={inputClass}
              placeholder="e.g. PKR"
              maxLength={3}
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addManual()}
              aria-invalid={!!manualError}
            />
            <Button onClick={addManual}>Add</Button>
          </div>
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={p.onFetchLatest} loading={p.loadingAction === 'fetch'} title="Ask the server to call the provider now">
          Fetch Latest Rates
        </Button>
        <Button onClick={p.onRefresh} loading={p.loadingAction === 'refresh'} title="Reload from the server (may use its short-lived cache)">
          Refresh Rates
        </Button>
        <span className="mx-1 hidden h-6 w-px bg-slate-200 sm:block" />
        <Button variant="ghost" onClick={p.onShowAll}>
          Show all currencies
        </Button>
        <Button variant="ghost" onClick={p.onResetSelection}>
          Reset to defaults
        </Button>
      </div>
    </div>
  );
}
