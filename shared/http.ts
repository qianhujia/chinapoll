// Shared request helpers used by both Workers.

import { errorPayload, type ApiErrorCode, type ApiErrorParams } from './errors';

export async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return typeof body === 'object' && body !== null ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function readString(body: Record<string, unknown> | null, key: string): string {
  if (!body) return '';
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

export function noStoreJson(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, {
    status,
    headers: { 'cache-control': 'no-store', ...headers }
  });
}

// A failing API response carrying a stable code for the frontend to translate.
// The English `message` is still included so older clients keep working.
export function apiError(
  code: ApiErrorCode,
  status: number,
  options: {
    params?: ApiErrorParams;
    extra?: Record<string, unknown>;
    headers?: Record<string, string>;
  } = {}
): Response {
  return noStoreJson(errorPayload(code, options.params, options.extra), status, options.headers);
}