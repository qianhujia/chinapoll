// Shared rate-limit parsing and Durable Object client for the public Worker.
//
// Rate limits use the "<count>/<unit>" format where unit is one of w, d, h, m, s.

import { RATE_LIMIT_PATTERN } from '../api/settings';

const UNIT_MS: Record<string, number> = {
  w: 7 * 24 * 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  h: 60 * 60 * 1000,
  m: 60 * 1000,
  s: 1000
};

export interface RateLimit {
  count: number;
  windowMs: number;
}

export interface RateLimitEnv {
  RATE_LIMITER: DurableObjectNamespace;
}

// Parses a rate-limit value, falling back to the given default when the value
// is missing or malformed so a single bad setting cannot break a handler.
export function parseRateLimit(value: string | null | undefined, fallback: string): RateLimit {
  const normalized = value?.trim().toLowerCase() ?? '';
  const source = RATE_LIMIT_PATTERN.test(normalized) ? normalized : fallback;
  const match = source.match(RATE_LIMIT_PATTERN);
  const count = match ? Number(match[1]) : 1;
  const unit = match ? match[2] : 'h';
  return { count, windowMs: UNIT_MS[unit] ?? UNIT_MS.h };
}

// Consumes one unit against the named scope/key through the Durable Object. The
// key never leaves the Worker in a form that can be tied back to a person.
export async function checkRateLimit(
  env: RateLimitEnv,
  scope: string,
  key: string,
  setting: string | undefined,
  fallback: string
): Promise<{ allowed: boolean; remaining: number }> {
  const { count, windowMs } = parseRateLimit(setting, fallback);
  const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(scope));
  const response = await stub.fetch('https://rate-limiter.internal/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, limit: count, windowMs })
  });
  if (!response.ok) return { allowed: false, remaining: 0 };
  return await response.json() as { allowed: boolean; remaining: number };
}
