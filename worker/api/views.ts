// Poll view counting.
//
// The goal is to count how often each poll is opened without recording who
// opened it. A view increments a single per-poll, per-UTC-day counter; there are
// no per-view rows anywhere, so a view can never be attributed to a viewer. The
// browser deduplicates itself (one call per tab session), and the server rate
// limits the call through the Durable Object with the keyed, daily-rotated
// network hash. The endpoint always answers 204 so the response reveals nothing,
// whether or not the rate limit was hit.

import type { HandlerEnv } from '../index';
import { checkRateLimit } from '../services/rateLimit';
import { clientAddress, hashedNetworkBucket, serverHmacKey } from '../services/ip';

const VIEW_RATE_LIMIT = '60/h';
const VIEW_PATH_PATTERN = /^\/api\/polls\/([1-9]\d*)\/view$/;

// Returns the start of the UTC day for a Unix timestamp, in seconds.
export function dayBucket(unixSeconds: number): number {
  return Math.floor(unixSeconds / 86400) * 86400;
}

export async function handleViewRequest(request: Request, url: URL, env: HandlerEnv): Promise<Response> {
  if (request.method !== 'POST') {
    return Response.json({ ok: false, message: 'POST only' }, { status: 405 });
  }

  const match = url.pathname.match(VIEW_PATH_PATTERN);
  if (!match) {
    return Response.json({ ok: false, message: 'not found' }, { status: 404 });
  }
  const pollId = Number(match[1]);
  if (!Number.isSafeInteger(pollId)) {
    return Response.json({ ok: false, message: 'invalid poll ID' }, { status: 400 });
  }

  // A missing poll is answered like every other outcome so the response cannot
  // be used to probe which polls exist.
  const poll = await env.DB.prepare('SELECT id FROM polls WHERE id = ?')
    .bind(pollId).first<{ id: number }>();
  if (!poll) return noContent();

  const ipHash = await hashedNetworkBucket(clientAddress(request), serverHmacKey(env));
  if (!ipHash) return noContent();

  const limited = await checkRateLimit(env, 'view', ipHash, undefined, VIEW_RATE_LIMIT);
  if (!limited.allowed) return noContent();

  // One statement, one D1 write per view. That is acceptable at this scale; a
  // per-poll Durable Object counter is the upgrade path if write volume becomes
  // a problem. Views are deliberately not buffered in Worker memory or KV.
  const tsDay = dayBucket(Math.floor(Date.now() / 1000));
  await env.DB.prepare(
    `INSERT INTO poll_views (poll_id, ts_day, views) VALUES (?, ?, 1)
     ON CONFLICT(poll_id, ts_day) DO UPDATE SET views = views + 1`
  ).bind(pollId, tsDay).run();

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

  const placeholders = pollIds.map(() => '?').join(', ');
  const result = await db.prepare(
    `SELECT poll_id,
            COALESCE(SUM(views), 0) AS total,
            COALESCE(SUM(CASE WHEN ts_day >= ? THEN views ELSE 0 END), 0) AS last7
     FROM poll_views WHERE poll_id IN (${placeholders}) GROUP BY poll_id`
  ).bind(last7DayCutoff(now), ...pollIds).all<{ poll_id: number; total: number; last7: number }>();

  for (const row of result.results ?? []) {
    counts.set(Number(row.poll_id), { total: Number(row.total), last7Days: Number(row.last7) });
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
