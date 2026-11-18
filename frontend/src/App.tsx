import { useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { useComparison } from './hooks/useComparison';
import { useErpPreview } from './hooks/useErpPreview';
import { useExchangeRates } from './hooks/useExchangeRates';
import { cx } from './lib/format';
import { PROVIDER_IDS } from './lib/providers';
import { DashboardPage } from './pages/DashboardPage';
import { ErpIntegrationPage } from './pages/ErpIntegrationPage';
import { exchangeRateApi } from './services/api';
import type { ProviderId, ProviderOption, ProviderView } from './types/api';

const DEFAULT_CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'SAR', 'CNY'];
const STORAGE_KEY = 'fx-poc:selected-currencies';
const PROVIDER_KEY = 'fx-poc:provider';
const ERP_PROVIDER_KEY = 'fx-poc:erp-provider';
const ERP_COUNTRY_KEY = 'fx-poc:erp-country';
const OANDA_TYPE_KEY = 'fx-poc:oanda-rate-type';
const PROVIDER_VIEWS: ProviderView[] = [...PROVIDER_IDS, 'compare'];

/** Per-viewer conveniences only – the app works the same when storage is unavailable. */
function load<T>(key: string, valid: (v: unknown) => v is T, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) {
      let v: unknown = raw; // earlier versions stored plain strings
      try {
        v = JSON.parse(raw);
      } catch {
        /* keep the raw string */
      }
      if (valid(v)) return v;
    }
  } catch {
    /* storage unavailable or old format */
  }
  return fallback;
}
function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}
const isCurrencyList = (v: unknown): v is string[] => Array.isArray(v) && v.every((c) => typeof c === 'string' && /^[A-Z]{3}$/.test(c));
const isProviderView = (v: unknown): v is ProviderView => PROVIDER_VIEWS.includes(v as ProviderView);
const isProviderId = (v: unknown): v is ProviderId => PROVIDER_IDS.includes(v as ProviderId);
const isOandaType = (v: unknown): v is string | null => v === null || v === 'midpoint' || v === 'bid' || v === 'ask';
const isCountry = (v: unknown): v is string | null => v === null || (typeof v === 'string' && /^[A-Z]{2}$/.test(v));

const NAV = [
  { to: '/dashboard', label: 'API Dashboard' },
  { to: '/erp-integration', label: 'ERP Integration' },
];

/**
 * App shell. All shared state and data hooks live here, above the routes, so switching between
 * /dashboard and /erp-integration keeps the selected provider, country and loaded data, and never refetches.
 */
export default function App() {
  // API Dashboard state
  const [target, setTarget] = useState('AED');
  const [selected, setSelected] = useState<string[]>(() => load(STORAGE_KEY, isCurrencyList, DEFAULT_CURRENCIES));
  const [search, setSearch] = useState('');
  const [historyCode, setHistoryCode] = useState<string | null>(null);
  const [providerView, setProviderView] = useState<ProviderView>(() => load(PROVIDER_KEY, isProviderView, 'exchangerate-api'));
  const [oandaRateType, setOandaRateType] = useState<string | null>(() => load<string | null>(OANDA_TYPE_KEY, isOandaType, null));
  const [providerOptions, setProviderOptions] = useState<ProviderOption[]>([
    { id: 'exchangerate-api', label: 'ExchangeRate-API', description: 'Existing integration.', configured: true, setupHint: null, rateTypes: null, defaultRateType: null },
    { id: 'currencyapi-com', label: 'currencyapi.com', description: 'Second integration for comparison.', configured: true, setupHint: null, rateTypes: null, defaultRateType: null },
    { id: 'oanda', label: 'OANDA', description: 'Third integration for comparison.', configured: true, setupHint: null, rateTypes: null, defaultRateType: null },
  ]);
  const comparing = providerView === 'compare';
  // In Compare Both, the status, converter and history use the existing provider (the reference).
  const dataProvider: ProviderId = comparing ? 'exchangerate-api' : providerView;
  // The chosen OANDA rate type only affects what is viewed; the ERP always uses the server's configured type.
  const viewRateType = dataProvider === 'oanda' ? (oandaRateType ?? undefined) : undefined;
  const rates = useExchangeRates(target, selected, dataProvider, viewRateType);
  const comparison = useComparison(target, selected, comparing, oandaRateType ?? undefined);

  // ERP Integration state – one effective-rate provider at a time (comparison never feeds the ERP).
  const [erpProvider, setErpProvider] = useState<ProviderId>(() => load(ERP_PROVIDER_KEY, isProviderId, 'exchangerate-api'));
  const [erpCountry, setErpCountry] = useState<string | null>(() => load<string | null>(ERP_COUNTRY_KEY, isCountry, null));
  const erp = useErpPreview(erpProvider, erpCountry);

  useEffect(() => {
    exchangeRateApi
      .getProviders()
      .then((r) => setProviderOptions(r.providers))
      .catch(() => {
        /* keep defaults; errors show per provider */
      });
  }, []);
  useEffect(() => save(PROVIDER_KEY, providerView), [providerView]);
  useEffect(() => save(STORAGE_KEY, selected), [selected]);
  useEffect(() => save(OANDA_TYPE_KEY, oandaRateType), [oandaRateType]);
  useEffect(() => save(ERP_PROVIDER_KEY, erpProvider), [erpProvider]);
  useEffect(() => {
    if (erpCountry) save(ERP_COUNTRY_KEY, erpCountry);
  }, [erpCountry]);

  // Choosing a single provider on the dashboard also makes it the ERP provider; Compare Both leaves the ERP choice alone.
  const changeProviderView = (v: ProviderView) => {
    setProviderView(v);
    if (v !== 'compare') setErpProvider(v);
  };

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-8 gap-y-2 px-4 sm:px-6">
          <div className="flex items-center gap-3 py-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-700 text-sm font-bold text-white">FX</div>
            <div>
              <h1 className="text-base font-semibold leading-tight text-slate-900">Exchange Rate Automation</h1>
              <p className="text-xs text-slate-500">Proof of concept · ERP (Zybo) rate feed</p>
            </div>
          </div>
          <nav aria-label="Main" className="flex self-stretch">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                className={({ isActive }) =>
                  cx(
                    'flex items-center border-b-2 px-4 text-sm font-medium transition',
                    isActive ? 'border-teal-700 text-teal-800' : 'border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-900',
                  )
                }
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
          <span className="ml-auto rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800 ring-1 ring-amber-200">
            POC – not connected to production ERP
          </span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-5 sm:px-6">
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route
            path="/dashboard"
            element={
              <DashboardPage
                providerView={providerView}
                onProviderViewChange={changeProviderView}
                providerOptions={providerOptions}
                dataProvider={dataProvider}
                oandaRateType={oandaRateType}
                onOandaRateTypeChange={setOandaRateType}
                target={target}
                onTargetChange={setTarget}
                selected={selected}
                onSelectedChange={setSelected}
                defaults={DEFAULT_CURRENCIES}
                search={search}
                onSearchChange={setSearch}
                historyCode={historyCode}
                onHistoryCodeChange={setHistoryCode}
                rates={rates}
                comparison={comparison}
              />
            }
          />
          <Route
            path="/erp-integration"
            element={
              <ErpIntegrationPage
                erp={erp}
                provider={erpProvider}
                onProviderChange={setErpProvider}
                providerOptions={providerOptions}
                countryCode={erpCountry}
                onCountryChange={setErpCountry}
              />
            }
          />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </main>

      <footer className="mx-auto w-full max-w-[1600px] px-4 pb-6 text-xs text-slate-500 sm:px-6">
        Technical feasibility POC. No data is written to Zybo or any database. Timestamps shown in UAE time (GST, UTC+4).
      </footer>
    </div>
  );
}
