import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, exchangeRateApi } from '../services/api';
import type { ComparisonResponse } from '../types/api';

/** Loads the side-by-side comparison of both providers (only while Compare Both is selected). */
export function useComparison(target: string, selected: string[], enabled: boolean, oandaRateType?: string) {
  const [data, setData] = useState<ComparisonResponse | null>(null);
  const [loading, setLoading] = useState<'initial' | 'refresh' | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const requestId = useRef(0);
  const key = selected.join(',');

  const load = useCallback(
    async (refresh: boolean) => {
      if (!enabled) return;
      const id = ++requestId.current;
      setLoading(refresh ? 'refresh' : 'initial');
      setError(null);
      try {
        const res = await exchangeRateApi.compare(target, key ? key.split(',') : [], refresh, oandaRateType);
        if (id === requestId.current) setData(res);
      } catch (e) {
        if (id === requestId.current) setError(e instanceof ApiError ? e : new ApiError(String(e), 'UNKNOWN', 0));
      } finally {
        if (id === requestId.current) setLoading(null);
      }
    },
    [target, key, enabled, oandaRateType],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  return { data, loading, error, reload: () => load(false), refresh: () => load(true) };
}
