import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, exchangeRateApi } from '../services/api';
import type { CurrencyOption, ProviderId, RatesResponse, StatusResponse } from '../types/api';

export interface RatesState {
  data: RatesResponse | null;
  status: StatusResponse | null;
  currencies: CurrencyOption[];
  loading: boolean;
  /** Which action triggered the current load, for button spinners. */
  loadingAction: 'initial' | 'refresh' | 'fetch' | null;
  error: ApiError | null;
}

/**
 * Loads rates for `target` + selected currencies.
 *  - refresh(): re-read from the backend (backend may serve its cache)
 *  - fetchLatest(): ask the backend to call the provider now (subject to its rate-limit guard)
 */
export function useExchangeRates(target: string, selected: string[], provider: ProviderId, rateType?: string) {
  const [state, setState] = useState<RatesState>({
    data: null,
    status: null,
    currencies: [],
    loading: true,
    loadingAction: 'initial',
    error: null,
  });
  const requestId = useRef(0);
  const key = selected.join(',');

  const load = useCallback(
    async (action: 'initial' | 'refresh' | 'fetch') => {
      const id = ++requestId.current;
      setState((s) => ({ ...s, loading: true, loadingAction: action, error: null }));
      try {
        const data = await exchangeRateApi.getRates(provider, target, key ? key.split(',') : [], action === 'fetch', rateType);
        const [status, currencies] = await Promise.all([
          exchangeRateApi.getStatus(provider, rateType).catch(() => null),
          exchangeRateApi.getCurrencies(provider, target, rateType).catch(() => null),
        ]);
        if (id !== requestId.current) return; // a newer request superseded this one
        setState((s) => ({
          data,
          status: status ?? s.status,
          currencies: currencies?.currencies ?? s.currencies,
          loading: false,
          loadingAction: null,
          error: null,
        }));
      } catch (e) {
        if (id !== requestId.current) return;
        const status = await exchangeRateApi.getStatus(provider, rateType).catch(() => null);
        setState((s) => ({
          ...s,
          data: null, // never show the previous provider's rates under a new provider's error
          status: status ?? s.status,
          loading: false,
          loadingAction: null,
          error: e instanceof ApiError ? e : new ApiError(String(e), 'UNKNOWN', 0),
        }));
      }
    },
    [target, key, provider, rateType],
  );

  useEffect(() => {
    void load('initial');
  }, [load]);

  return {
    ...state,
    refresh: () => load('refresh'),
    fetchLatest: () => load('fetch'),
  };
}
