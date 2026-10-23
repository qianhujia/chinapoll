// API error handling shared by every caller that displays a backend error.
//
// The backend answers a failing request with a stable code:
//   { "error": { "code": "USERNAME_TAKEN", "params": {} }, "message": "username is already taken" }
// This module turns that into the message for the visitor's current language,
// using the existing i18n dictionary (`errors.<CODE>`), and keeps working with
// the shapes older endpoints returned.
//
// Nothing here reaches the network or creates a second i18n instance: it reads
// the dictionary the application already loaded and translates locally.

import { DEFAULT_LOCALE, getLocaleText, hasLocaleText, type Locale } from '../i18n';
import { ERROR_MESSAGES, interpolateParams, type ApiErrorParams } from '../../shared/errors';

// Client-side codes for failures that never reach the API. They live in the same
// `errors.*` namespace so the frontend translates them the same way.
export const NETWORK_ERROR_CODE = 'NETWORK_ERROR';
export const TIMEOUT_CODE = 'TIMEOUT';
export const UNKNOWN_ERROR_CODE = 'UNKNOWN';

const ERROR_KEY_PREFIX = 'errors.';

// Reverse lookup so a legacy response that only carries the English text still
// translates: the text of every registered code is unique.
const CODE_BY_MESSAGE = new Map<string, string>(
  Object.entries(ERROR_MESSAGES).map(([code, message]) => [message, code])
);

// Last-resort mapping when the body carries no usable code or text (for example
// an HTML error page from the edge).
const CODE_BY_STATUS: Readonly<Record<number, string>> = {
  403: 'PERMISSION_DENIED',
  404: 'RESOURCE_NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  429: 'RATE_LIMIT_EXCEEDED',
  500: 'INTERNAL_ERROR',
  502: 'INTERNAL_ERROR',
  503: 'INTERNAL_ERROR',
  504: 'INTERNAL_ERROR'
};

export interface ApiErrorDetails {
  /** Stable code, or null when the response carried none. */
  code: string | null;
  params: ApiErrorParams;
  /** The English text the API returned, if any. */
  message: string;
  status: number | null;
}

// An error carrying the parsed API details. `fetchJson` throws this so callers
// keep seeing an Error while the code and params stay available.
export class ApiError extends Error {
  readonly code: string | null;
  readonly params: ApiErrorParams;
  readonly status: number | null;

  constructor(message: string, details: Partial<ApiErrorDetails> = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = details.code ?? null;
    this.params = details.params ?? {};
    this.status = details.status ?? null;
  }
}

function isParams(value: unknown): value is ApiErrorParams {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>)
    .every((entry) => typeof entry === 'string' || typeof entry === 'number');
}

// Reads `{ code, params }` from a nested object when it looks like an error
// descriptor.
function readCode(value: unknown): { code: string; params: ApiErrorParams } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.code !== 'string' || record.code.length === 0) return null;
  return { code: record.code, params: isParams(record.params) ? record.params : {} };
}

// Extracts the code, params, and legacy text from any error body the API has
// used: { error: { code, params } }, { detail: { code } }, { detail: 'text' },
// { message: 'text' }, or a bare string. A framework validation array (or any
// other unexpected shape) yields nothing, so the caller falls back to the
// localized generic message instead of guessing.
export function parseApiErrorPayload(payload: unknown): ApiErrorDetails {
  if (typeof payload === 'string') {
    return { code: null, params: {}, message: payload.trim(), status: null };
  }
  if (Array.isArray(payload) || !payload || typeof payload !== 'object') {
    return { code: null, params: {}, message: '', status: null };
  }

  const record = payload as Record<string, unknown>;
  const descriptor = readCode(record.error) ?? readCode(record.detail) ?? readCode(record);
  const message = typeof record.message === 'string'
    ? record.message
    : typeof record.detail === 'string'
      ? record.detail
      : '';

  return {
    code: descriptor?.code ?? null,
    params: descriptor?.params ?? {},
    message,
    status: null
  };
}

// A failure that never reached the API: the fetch itself failed or was aborted.
function networkErrorCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return TIMEOUT_CODE;
  if (error instanceof TypeError) return NETWORK_ERROR_CODE;
  return null;
}

// The code to display for a thrown value: the API code when present, otherwise a
// reverse-mapped legacy text or a status-based fallback, otherwise null.
export function apiErrorCode(error: unknown): string | null {
  if (error instanceof ApiError) {
    if (error.code) return error.code;
    if (error.message && CODE_BY_MESSAGE.has(error.message)) return CODE_BY_MESSAGE.get(error.message) ?? null;
    if (error.status !== null) return CODE_BY_STATUS[error.status] ?? null;
    return null;
  }
  return networkErrorCode(error);
}

// The localized text for a code, or null when the dictionary has no entry (an
// unknown code from a newer backend, for example).
export function translateApiErrorCode(
  code: string | null,
  params: ApiErrorParams = {},
  locale: Locale = DEFAULT_LOCALE
): string | null {
  if (!code) return null;
  const key = ERROR_KEY_PREFIX + code;
  if (!hasLocaleText(locale, key)) return null;
  return interpolateParams(getLocaleText(locale, key), params);
}

// The one message shown when an error cannot be identified reliably.
export function genericErrorMessage(locale: Locale = DEFAULT_LOCALE): string {
  return getLocaleText(locale, `${ERROR_KEY_PREFIX}${UNKNOWN_ERROR_CODE}`);
}

// The message to display for any thrown value. Raw exception text, stack traces,
// and unknown backend text are never surfaced.
export function apiErrorMessage(error: unknown): string {
  const code = apiErrorCode(error);
  const params = error instanceof ApiError ? error.params : {};
  return translateApiErrorCode(code, params) ?? genericErrorMessage();
}

