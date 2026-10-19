// Per-poll view counter Durable Object.
//
// One instance per poll (`VIEW_COUNTER.idFromName(String(pollId))`) buffers view
// increments in memory and flushes them to `poll_views` on a five-minute alarm, so
// a view costs one Durable Object call from the request Worker and no database
// write. The object holds only a `pending` count and nothing about visitors: the
// per-network rate limit is enforced inside the same call by delegating to the
// RateLimiter Durable Object with the keyed, daily-rotated network hash, which the
// caller passes in and the object never stores.
//
// Counts are approximate by design. An object that is evicted between flushes
// loses up to five minutes of views, so D1 writes drop from one per view to at
// most twelve per active poll per hour. The hourly cron, the snapshots, and the
// 90-day roll-up keep reading `poll_views` unchanged.

import { checkRateLimit, type RateLimitEnv } from './rateLimit';

export interface ViewCounterEnv extends RateLimitEnv {
  DB: D1Database;
  VIEW_COUNTER: DurableObjectNamespace;
}

// How long increments are buffered before a flush.
const FLUSH_INTERVAL_MS = 5 * 60 * 1000;
// The per-network view rate limit. The endpoint always answers 204, so this only
// decides whether a view is counted.
const VIEW_RATE_LIMIT = '60/h';
const COUNTER_URL = 'https://view-counter.internal/';
const FLUSH_SQL = `INSERT INTO poll_views (poll_id, ts_day, views) VALUES (?, ?, ?)
   ON CONFLICT(poll_id, ts_day) DO UPDATE SET views = views + excluded.views`;

interface ViewRequest {
  pollId?: number;
  ipHash?: string;
}

export class ViewCounter {
  // Views counted since the last flush. Nothing else is kept in memory.
  private pending = 0;
  // In-memory view of whether a flush is already scheduled.
  private alarmArmed = false;

  constructor(private state: DurableObjectState, private env: ViewCounterEnv) {}

  async fetch(request: Request): Promise<Response> {
    let body: ViewRequest;
    try {
      body = await request.json() as ViewRequest;
    } catch {
      return Response.json({ ok: false, message: 'invalid JSON' }, { status: 400 });
    }

    const pollId = Number(body.pollId ?? 0);
    const ipHash = typeof body.ipHash === 'string' ? body.ipHash : '';
    if (!Number.isSafeInteger(pollId) || pollId < 1 || !ipHash) {
      return Response.json({ ok: false, message: 'invalid view request' }, { status: 400 });
    }

    // The per-network rate limit rides along in this same call, so the request
    // Worker does not make a second subrequest.
    const limited = await checkRateLimit(this.env, 'view', ipHash, undefined, VIEW_RATE_LIMIT);
    if (!limited.allowed) return Response.json({ ok: true, counted: false });

    this.pending += 1;
    await this.armFlush();
    return Response.json({ ok: true, counted: true });
  }

  // Flushes the buffered count to `poll_views` and resets the buffer.
  async alarm(): Promise<void> {
    const pending = this.pending;
    this.pending = 0;
    this.alarmArmed = false;
    if (pending <= 0) return;

    const pollId = Number(this.state.id.name);
    if (!Number.isSafeInteger(pollId) || pollId < 1) return;

    // Same UTC-day bucket as worker/api/views.ts.
    const tsDay = Math.floor((Date.now() / 1000) / 86400) * 86400;
    try {
      await this.env.DB.prepare(FLUSH_SQL).bind(pollId, tsDay, pending).run();
    } catch (error) {
      // A poll that no longer exists fails the foreign key; the buffered views
      // are dropped rather than retried forever.
      console.error('view counter flush failed', error instanceof Error ? error.message : error);
    }
  }

  // Arms one flush five minutes out, unless a flush is already scheduled. The
  // scheduled alarm is checked once per object lifetime rather than per view.
  private async armFlush(): Promise<void> {
    if (this.alarmArmed) return;
    const existing = await this.state.storage.getAlarm();
    if (existing === null) {
      await this.state.storage.setAlarm(Date.now() + FLUSH_INTERVAL_MS);
    }
    this.alarmArmed = true;
  }
}

// Records one view by calling the poll's counter object. The view endpoint always
// answers 204, so a failure here is swallowed.
export async function countView(env: ViewCounterEnv, pollId: number, ipHash: string): Promise<void> {
  try {
    const stub = env.VIEW_COUNTER.get(env.VIEW_COUNTER.idFromName(String(pollId)));
    await stub.fetch(COUNTER_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pollId, ipHash })
    });
  } catch (error) {
    console.error('view counter call failed', error instanceof Error ? error.message : error);
  }
}
