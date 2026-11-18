import type {
  ApiErrorBody,
  AuditEvent,
  ComparisonResponse,
  ConversionResponse,
  CurrencyOption,
  EditorSessionInfo,
  EffectiveRate,
  ErpListResponse,
  HistoryResponse,
  ProviderId,
  ProvidersResponse,
  RateHistoryEntry,
  RatesResponse,
  ScheduleState,
  StatusResponse,
} from '../types/api';

/**
 * Rate-editor session token. Kept in sessionStorage (cleared when the tab closes) and sent as a Bearer token.
 * The backend decides what the token may do; the browser only stores it.
 */
const TOKEN_KEY = 'fx-poc:editor-token';
let editorToken: string | null = (() => {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
})();

export function setEditorToken(token: string | null): void {
  editorToken = token;
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable – token lives in memory only */
  }
}

/** Error thrown for any failed API call, carrying the backend's error code. */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(editorToken ? { Authorization: `Bearer ${editorToken}` } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError('Cannot reach the POC backend. Is it running on port 4000?', 'BACKEND_UNREACHABLE', 0);
  }
  const isJson = res.headers.get('content-type')?.includes('application/json');
  if (!res.ok) {
    if (isJson) {
      const body = (await res.json()) as ApiErrorBody;
      throw new ApiError(body.error?.message ?? `Request failed (${res.status})`, body.error?.code ?? 'UNKNOWN', res.status);
    }
    throw new ApiError(
      res.status === 502 || res.status === 504
        ? 'Cannot reach the POC backend. Is it running on port 4000?'
        : `Request failed (${res.status})`,
      'BACKEND_UNREACHABLE',
      res.status,
    );
  }
  return (isJson ? res.json() : res.text()) as Promise<T>;
}

const qs = (params: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

const post = <T>(path: string, body: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body) });

/** Every rate call names the provider; the backend defaults to the existing integration. API keys never reach the browser. */
export const exchangeRateApi = {
  getProviders: () => request<ProvidersResponse>('/api/providers'),
  getRates: (provider: ProviderId, target: string, currencies: string[], refresh = false, rateType?: string) =>
    request<RatesResponse>(
      `/api/exchange-rates${qs({ provider, rateType, target, currencies: currencies.join(','), refresh: refresh ? 'true' : undefined })}`,
    ),
  getCurrencies: (provider: ProviderId, target: string, rateType?: string) =>
    request<{ target: string; currencies: CurrencyOption[] }>(`/api/exchange-rates/currencies${qs({ provider, rateType, target })}`),
  getStatus: (provider: ProviderId, rateType?: string) => request<StatusResponse>(`/api/exchange-rates/status${qs({ provider, rateType })}`),
  convert: (provider: ProviderId, target: string, from: string, to: string, amount: string, rateType?: string) =>
    request<ConversionResponse>(`/api/exchange-rates/convert${qs({ provider, rateType, target, from, to, amount })}`),
  getHistory: (provider: ProviderId, target: string, currency: string, days: number, rateType?: string) =>
    request<HistoryResponse>(`/api/exchange-rates/history${qs({ provider, rateType, target, currency, days: String(days) })}`),
  compare: (target: string, currencies: string[], refresh = false, rateType?: string) =>
    request<ComparisonResponse>(
      `/api/exchange-rates/compare${qs({ rateType, target, currencies: currencies.join(','), refresh: refresh ? 'true' : undefined })}`,
    ),
};

type Pair = { provider: ProviderId; country: string; currency: string };

export const erpApi = {
  list: (provider: ProviderId, country?: string) => request<ErpListResponse>(`/api/erp-preview${qs({ provider, country })}`),
  history: (p: Pair) => request<{ history: RateHistoryEntry[] }>(`/api/erp-preview/history${qs(p)}`),
  audit: (provider: ProviderId, country?: string) => request<{ events: AuditEvent[] }>(`/api/erp-preview/audit${qs({ provider, country })}`),
  override: (p: Pair, rate: string, reason: string) => post<{ rate: EffectiveRate }>('/api/erp-preview/rates/override', { ...p, rate, reason }),
  resume: (p: Pair) => post<{ rate: EffectiveRate }>('/api/erp-preview/rates/resume', p),
  accept: (p: Pair) => post<{ rate: EffectiveRate }>('/api/erp-preview/rates/accept', p),
  schedule: () => request<ScheduleState>('/api/erp-preview/schedule'),
  runSchedule: () => post<ScheduleState>('/api/erp-preview/schedule/run', {}),
  sql: (provider: ProviderId, country?: string) => request<string>(`/api/erp-preview/sql${qs({ provider, country })}`),
  reset: () => request<{ notice: string }>('/api/erp-preview', { method: 'DELETE' }),
};

export const authApi = {
  me: () => request<EditorSessionInfo>('/api/auth/me'),
  login: (passcode: string) => post<{ token: string; name: string; expiresAt: string }>('/api/auth/login', { passcode }),
  logout: () => post<{ ok: boolean }>('/api/auth/logout', {}),
};
