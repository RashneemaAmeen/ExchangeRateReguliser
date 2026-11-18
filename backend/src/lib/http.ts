import https from 'node:https';
import { rootCertificates } from 'node:tls';
import { AppError } from './errors.js';

export interface FetchJsonResult {
  status: number;
  body: unknown;
}

export interface FetchJsonOptions {
  allowErrorStatus?: boolean;
  providerName?: string;
  /** Extra request headers (for example an API key). Never logged. */
  headers?: Record<string, string>;
  /**
   * Extra PEM-encoded CA certificates to trust in addition to Node's built-in list. Used when a company firewall
   * re-signs HTTPS traffic with its own CA. Certificate checking stays ON.
   */
  extraCa?: string[];
  /** Appended to the TLS error message (what to do about it for this provider). */
  tlsHint?: string;
}

const TLS_ERROR_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_UNTRUSTED',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

interface RawResponse {
  status: number;
  text: string;
}

/** GET through node:https so extra CA certificates can be supplied (fetch has no per-request CA option). */
function httpsGet(url: string, timeoutMs: number, headers: Record<string, string>, extraCa: string[]): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        method: 'GET',
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        headers,
        ca: [...rootCertificates, ...extraCa],
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { name: 'TimeoutError' })));
    req.on('error', reject);
    req.end();
  });
}

/**
 * GET a JSON document with a hard timeout. Maps every failure to an AppError so
 * callers (and ultimately the frontend) receive a consistent error shape.
 * Non-2xx responses are returned (not thrown) when `allowErrorStatus` is set, so
 * providers can interpret documented error payloads.
 */
export async function fetchJson(url: string, timeoutMs: number, opts: FetchJsonOptions = {}): Promise<FetchJsonResult> {
  const who = opts.providerName ?? 'Exchange-rate provider';
  const headers = { Accept: 'application/json', 'User-Agent': 'exchange-rate-poc/0.1', ...opts.headers };
  let raw: RawResponse;
  try {
    if (opts.extraCa?.length) {
      raw = await httpsGet(url, timeoutMs, headers, opts.extraCa);
    } else {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      raw = { status: res.status, text: await res.text() };
    }
  } catch (err) {
    const e = err as { name?: string; code?: string; message?: string; cause?: { code?: string; message?: string } };
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw new AppError(504, 'UPSTREAM_TIMEOUT', `${who} did not respond within ${timeoutMs} ms.`);
    }
    const code = e.cause?.code ?? e.code;
    if (code && TLS_ERROR_CODES.has(code)) {
      // The host name is safe to show; the URL is not (it can carry query data).
      const host = new URL(url).host;
      throw new AppError(
        502,
        'UPSTREAM_TLS_ERROR',
        `${who}: the secure connection to ${host} could not be verified (${code}). A firewall or proxy that inspects HTTPS ` +
          `traffic (for example Sophos) may be replacing the site's certificate, or blocking this site.${opts.tlsHint ? ` ${opts.tlsHint}` : ''}`,
      );
    }
    throw new AppError(502, 'UPSTREAM_NETWORK_ERROR', `Could not connect to ${who}: ${e.cause?.message ?? e.message ?? 'network error'}`);
  }

  const ok = raw.status >= 200 && raw.status < 300;
  if (!ok && !opts.allowErrorStatus) {
    throw new AppError(502, 'UPSTREAM_HTTP_ERROR', `${who} returned HTTP ${raw.status}.`, { status: raw.status });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw.text);
  } catch {
    if (!ok) {
      throw new AppError(502, 'UPSTREAM_HTTP_ERROR', `${who} returned HTTP ${raw.status}.`, { status: raw.status });
    }
    throw new AppError(502, 'UPSTREAM_INVALID_RESPONSE', `${who} returned a response that is not valid JSON (HTTP ${raw.status}).`);
  }
  return { status: raw.status, body };
}
