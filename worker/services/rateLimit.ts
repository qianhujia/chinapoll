// Shared rate-limit parsing for the public Worker.
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

// Returns the current millisecond bucket start for a window, matching the
// ts_bucket convention used by the vote, comment, and poll rate limits.
export function currentBucketStart(windowMs: number): number {
  const now = Date.now();
  return now - (now % windowMs);
}
