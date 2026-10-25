// Poll view counting.
//
// The goal is to count how often each poll is opened without recording who
// opened it. A view increments the poll's ViewCounter Durable Object, which
// buffers the count in memory and flushes it to a single per-poll, per-UTC-day
// row every five minutes; there are no per-view rows anywhere, so a view can
// never be attributed to a viewer. The browser deduplicates itself (one call per
// tab session), and the object enforces the per-network rate limit inside the
// same call with the keyed, daily-rotated network hash. A well-formed same-origin
// POST always answers 204 so the response reveals nothing, whether or not the rate
// limit was hit; a cross-origin or malformed request is refused with the standard
// error before the counter is touched.

import type { HandlerEnv } from '../index';
import { enforceSameOrigin } from '../services/csrf';
import { countView } from '../services/viewCounter';
import { clientAddress, hashedNetworkBucket, serverHmacKey } from '../services/ip';
import { apiError } from '../../shared/http';
import { chunk } from '../../shared/db';

const VIEW_PATH_PATTERN = /^\/api\/polls\/([1-9]\d*)\/view$/;

// Returns the start of the UTC day for a Unix timestamp, in seconds.
export function dayBucket(unixSeconds: number): number {
  return Math.floor(unixSeconds / 86400) * 86400;
}

export async function handleViewRequest(request: Request, url: URL, env: HandlerEnv): Promise<Response> {
  if (request.method !== 'POST') {
    return apiError('POST_ONLY', 405, { extra: { ok: false } });
  }

  // A third-party page must not be able to inflate a poll's view count from its
  // visitors' browsers, so the Origin check runs before the counter is touched.
  const csrf = enforceSameOrigin(request);
  if (csrf) return csrf;

  const match = url.pathname.match(VIEW_PATH_PATTERN);
  if (!match) {
    return apiError('RESOURCE_NOT_FOUND', 404, { extra: { ok: false } });
  }
  const pollId = Number(match[1]);
  if (!Number.isSafeInteger(pollId)) {
    return apiError('INVALID_POLL_ID', 400, { extra: { ok: false } });
  }

  // The keyed, daily-rotated network hash is computed here and passed to the
  // counter, which never stores it. A missing server key means no counting.
  const ipHash = await hashedNetworkBucket(clientAddress(request), serverHmacKey(env));
  if (!ipHash) return noContent();

  // One call: the object enforces the per-network rate limit, buffers the view,
  // and flushes it to D1 on its alarm. A view for a poll that does not exist is
  // buffered too; its flush fails the foreign key and is dropped, so the response
  // still reveals nothing about which polls exist.
  await countView(env, pollId, ipHash);

  return noContent();
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

export interface PollViewCounts {
  total: number;
  last7Days: number;
}

// Start of the current UTC day, in seconds.
export function todayBucket(now = Date.now()): number {
  return dayBucket(Math.floor(now / 1000));
}

// Cutoff for the "last 7 days" window: today plus the six preceding day buckets.
export function last7DayCutoff(now = Date.now()): number {
  return todayBucket(now) - 6 * 86400;
}

// Loads the total and last-7-day view counts for a set of polls in one query.
// The rollup rows written by maintenance use `ts_day = 0`, so they count toward
// the long-term total but never toward the recent window.
export async function loadViewCounts(
  db: D1Database,
  pollIds: number[],
  now = Date.now()
): Promise<Map<number, PollViewCounts>> {
  const counts = new Map<number, PollViewCounts>();
  if (pollIds.length === 0) return counts;

  // One query per batch: the cutoff and the id list share the statement's
  // parameters, and a page of polls can reach the 100-parameter ceiling.
  for (const batch of chunk(pollIds)) {
    const placeholders = batch.map(() => '?').join(', ');
    const result = await db.prepare(
      `SELECT poll_id,
              COALESCE(SUM(views), 0) AS total,
              COALESCE(SUM(CASE WHEN ts_day >= ? THEN views ELSE 0 END), 0) AS last7
       FROM poll_views WHERE poll_id IN (${placeholders}) GROUP BY poll_id`
    ).bind(last7DayCutoff(now), ...batch).all<{ poll_id: number; total: number; last7: number }>();

    for (const row of result.results ?? []) {
      counts.set(Number(row.poll_id), { total: Number(row.total), last7Days: Number(row.last7) });
    }
  }
  return counts;
}

// Applies the display threshold. Below it the count is withheld so a poll with a
// couple of views and one vote cannot be used to guess the voter.
export function publicViews(counts: PollViewCounts | undefined, threshold: number): PollViewCounts | null {
  if (!counts) return null;
  if (threshold > 0 && counts.total < threshold) return null;
  return counts;
}
