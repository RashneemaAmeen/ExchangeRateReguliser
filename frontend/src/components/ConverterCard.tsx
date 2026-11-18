import { useEffect, useState } from 'react';
import { ApiError, exchangeRateApi } from '../services/api';
import type { ConversionResponse, CurrencyOption, ProviderId } from '../types/api';
import { formatDate, groupDigits } from '../lib/format';
import { Alert, Button, Card, Field, inputClass } from './ui';

const AMOUNT_RE = /^\d{1,15}(\.\d{1,12})?$/;

export function ConverterCard({ target, currencies, provider, rateType }: { target: string; currencies: CurrencyOption[]; provider: ProviderId; rateType?: string }) {
  const [amount, setAmount] = useState('1000');
  const [from, setFrom] = useState('USD');
  const [to, setTo] = useState(target);
  const [result, setResult] = useState<ConversionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => setTo(target), [target]);

  const options = [{ code: target, name: '' }, ...currencies.filter((c) => c.code !== target)];
  const cleanAmount = amount.replace(/,/g, '').trim();
  const amountValid = AMOUNT_RE.test(cleanAmount) && !/^0+(\.0+)?$/.test(cleanAmount);

  const run = async () => {
    if (!amountValid) return;
    setLoading(true);
    setError(null);
    try {
      setResult(await exchangeRateApi.convert(provider, target, from, to, cleanAmount, rateType));
    } catch (e) {
      setResult(null);
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card title="Currency conversion calculator" subtitle="Indicative only – uses reference rates, not transaction rates">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <Field label="Amount" hint={!amountValid && amount ? 'Enter a positive number (up to 12 decimals)' : undefined}>
          <input className={inputClass + ' tabular font-mono'} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
          <Field label="From">
            <select className={inputClass} value={from} onChange={(e) => setFrom(e.target.value)}>
              {options.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code}
                </option>
              ))}
            </select>
          </Field>
          <Button
            variant="ghost"
            className="mb-0.5"
            aria-label="Swap currencies"
            onClick={() => {
              setFrom(to);
              setTo(from);
            }}
          >
            ⇄
          </Button>
          <Field label="To">
            <select className={inputClass} value={to} onChange={(e) => setTo(e.target.value)}>
              {options.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Button type="submit" variant="primary" className="w-full" loading={loading} disabled={!amountValid}>
          Convert
        </Button>
      </form>

      {error && (
        <div className="mt-4">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      {result && (
        <div className="mt-4 rounded-lg bg-slate-50 p-4">
          <p className="text-sm text-slate-500">
            {groupDigits(result.amount)} {result.from} =
          </p>
          <p className="tabular mt-1 font-mono text-2xl font-semibold text-slate-900">
            {groupDigits(result.result)} <span className="text-base text-slate-500">{result.to}</span>
          </p>
          <dl className="mt-3 space-y-1 text-xs text-slate-600">
            <div className="flex justify-between gap-2">
              <dt>Rate</dt>
              <dd className="tabular font-mono">
                1 {result.from} = {result.rate} {result.to}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>Inverse</dt>
              <dd className="tabular font-mono">
                1 {result.to} = {result.inverseRate} {result.from}
              </dd>
            </div>
            {result.from !== result.via && result.to !== result.via && (
              <div className="flex justify-between gap-2">
                <dt>Method</dt>
                <dd>Cross rate via {result.via}</dd>
              </div>
            )}
            <div className="flex justify-between gap-2">
              <dt>Rate date / source</dt>
              <dd className="text-right">
                {formatDate(result.effectiveDate)} · {result.provider.name}
              </dd>
            </div>
          </dl>
          <p className="mt-2 text-xs text-slate-500">
            Result rounded half-up to {result.resultDecimalPlaces} decimal place(s) ({result.to} minor units).
          </p>
        </div>
      )}
    </Card>
  );
}
