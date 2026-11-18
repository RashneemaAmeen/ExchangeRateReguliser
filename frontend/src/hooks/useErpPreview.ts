import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, authApi, erpApi, setEditorToken } from '../services/api';
import type { EditorSessionInfo, ErpListResponse, ProviderId, ScheduleState } from '../types/api';

/**
 * Effective ERP rates for one provider + country, the automatic-update schedule, and the rate-editor session.
 * Rates refresh every minute so the scheduled update shows up without reloading the page.
 */
export function useErpPreview(provider: ProviderId, country: string | null) {
  const [data, setData] = useState<ErpListResponse | null>(null);
  const [schedule, setSchedule] = useState<ScheduleState | null>(null);
  const [session, setSession] = useState<EditorSessionInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const requestId = useRef(0);

  const reload = useCallback(async () => {
    const id = ++requestId.current;
    try {
      const [list, sched, me] = await Promise.all([
        erpApi.list(provider, country ?? undefined),
        erpApi.schedule().catch(() => null),
        authApi.me().catch(() => null),
      ]);
      if (id !== requestId.current) return;
      setData(list);
      if (sched) setSchedule(sched);
      if (me) {
        setSession(me);
        if (!me.session) setEditorToken(null); // expired or server restarted
      }
    } catch (e) {
      if (id === requestId.current) setError(e instanceof ApiError ? e.message : String(e));
    }
  }, [provider, country]);

  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), 60_000);
    return () => clearInterval(t);
  }, [reload]);

  /** Runs an action, then refreshes. Returns true on success. */
  const run = useCallback(
    async (key: string, fn: () => Promise<unknown>, done?: string): Promise<boolean> => {
      setBusy(key);
      setError(null);
      setMessage(null);
      try {
        await fn();
        if (done) setMessage(done);
        await reload();
        return true;
      } catch (e) {
        setError(e instanceof ApiError ? e.message : String(e));
        if (e instanceof ApiError && e.status === 403) await reload(); // session may have expired
        return false;
      } finally {
        setBusy(null);
      }
    },
    [reload],
  );

  const pair = (currency: string) => ({ provider, country: country ?? data?.defaultCountry ?? 'AE', currency });
  const isEditor = Boolean(session?.session);

  return {
    data,
    schedule,
    session,
    isEditor,
    busy,
    error,
    message,
    clearError: () => setError(null),
    clearMessage: () => setMessage(null),
    reload,
    override: (currency: string, rate: string, reason: string) =>
      run(`override:${currency}`, () => erpApi.override(pair(currency), rate, reason), `${currency} is now a manual override. Automatic updates will not change it.`),
    resume: (currency: string) =>
      run(`resume:${currency}`, () => erpApi.resume(pair(currency)), `${currency} is back on automatic updates.`),
    accept: (currency: string) => run(`accept:${currency}`, () => erpApi.accept(pair(currency)), `The API rate for ${currency} is now effective.`),
    runNow: () => run('runNow', () => erpApi.runSchedule(), 'Automatic update finished – see the result below.'),
    reset: () => run('reset', () => erpApi.reset(), 'Simulation cleared: overrides and history removed, and fresh rates loaded from the provider.'),
    login: async (passcode: string) => {
      setBusy('login');
      setError(null);
      try {
        const r = await authApi.login(passcode);
        setEditorToken(r.token);
        await reload();
        return true;
      } catch (e) {
        setError(e instanceof ApiError ? e.message : String(e));
        return false;
      } finally {
        setBusy(null);
      }
    },
    logout: async () => {
      await authApi.logout().catch(() => null);
      setEditorToken(null);
      await reload();
    },
  };
}
