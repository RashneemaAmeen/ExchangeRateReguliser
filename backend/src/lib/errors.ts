export type ErrorCode =
  | 'INVALID_CURRENCY'
  | 'UNSUPPORTED_CURRENCY'
  | 'VALIDATION_ERROR'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_HTTP_ERROR'
  | 'UPSTREAM_NETWORK_ERROR'
  | 'UPSTREAM_TLS_ERROR'
  | 'UPSTREAM_INVALID_RESPONSE'
  | 'UPSTREAM_UNAVAILABLE'
  | 'HISTORY_NOT_SUPPORTED'
  | 'HISTORY_LIMITED'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'PROVIDER_AUTH_FAILED'
  | 'PROVIDER_PLAN_LIMIT'
  | 'PROVIDER_QUOTA_EXCEEDED'
  | 'PROVIDER_TRIAL_EXPIRED'
  | 'NOT_FOUND'
  | 'RECORD_LOCKED'
  | 'INVALID_STATE'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'TOO_MANY_ATTEMPTS'
  | 'INTERNAL_ERROR';

/** An error with an HTTP status and a stable machine-readable code. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;
