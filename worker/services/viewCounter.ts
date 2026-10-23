// Per-poll view counter Durable Object.
//
// One instance per poll (`VIEW_COUNTER.idFromName(String(pollId))`) buffers view
// increments in memory and flushes them to `poll_views` on a five-minute alarm, so
// a page view costs a single Durable Object request and no database write. The
// per-network rate limit also lives in the object's own memory, keyed by the
// daily-rotated network hash the caller passes in (never persisted), so the
// request makes no second object call and writes no rate-limit rows. The object
// holds a pending count and the in-memory rate windows, and nothing about
// visitors.
//
// Everything here is approximate by design: an object that is evicted between
// flushes loses up to five minutes of views and resets its in-memory rate windows,
// which drops D1 writes from one per view to at most twelve per active poll per
// hour. The hourly cron, the snapshots, and the 90-day roll-up keep reading
// `poll_views` unchanged.


import { apiError } from '../../shared/http';
export interface ViewCounterEnv {
  DB: D1Database;
  VIEW_COUNTER: DurableObjectNamespace;
}

// How long increments are buffered before a flush.
const FLUSH_INTERVAL_MS = 5 * 60 * 1000;
// Per-network view rate window. The endpoint always answers 204, so this only
// decides whether a view is counted.
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT = 60;
// The in-memory rate windows are pruned before they can grow past this many keys.
const MAX_TRACKED_NETWORKS = 4096;
const COUNTER_URL = 'https://view-counter.internal/';
const FLUSH_SQL = `INSERT INTO poll_views (poll_id, ts_day, views) VALUES (?, ?, ?)
   ON CONFLICT(poll_id, ts_day) DO UPDATE SET views = views + excluded.views`;

interface ViewRequest {
  pollId?: number;
  ipHash?: string;
}

interface RateWindow {
  count: number;
  resetAt: number;
}

export class ViewCounter {
  // Views counted since the last flush.
  private pending = 0;
  // In-memory view of whether a flush is already scheduled.
  private alarmArmed = false;
  // Fixed-window view rate limit per network hash, kept only in memory.
  private readonly windows = new Map<string, RateWindow>();

  constructor(private state: DurableObjectState, private env: ViewCounterEnv) {}

  async fetch(request: Request): Promise<Response> {
    let body: ViewRequest;
    try {
      body = await request.json() as ViewRequest;
    } catch {
      return apiError('INVALID_JSON', 400, { extra: { ok: false } });
    }

    const pollId = Number(body.pollId ?? 0);
    const ipHash = typeof body.ipHash === 'string' ? body.ipHash : '';
    if (!Number.isSafeInteger(pollId) || pollId < 1 || !ipHash) {
      return apiError('INVALID_VIEW_REQUEST', 400, { extra: { ok: false } });
    }

    // The per-network rate limit is a local memory check, so the request path
    // never calls another object and never writes a rate-limit row.
    if (!this.allow(ipHash)) return Response.json({ ok: true, counted: false });

    this.pending += 1;
    await this.armFlush();
    return Response.json({ ok: true, counted: true });
  }

  // True when this network bucket is still under the hourly view limit. The
  // window lives only in memory: an eviction resets it, like the buffered count.
  private allow(networkHash: string): boolean {
    const now = Date.now();
    if (this.windows.size >= MAX_TRACKED_NETWORKS) this.prune(now);
    const window = this.windows.get(networkHash);
    if (!window || window.resetAt <= now) {
      this.windows.set(networkHash, { count: 1, resetAt: now + RATE_WINDOW_MS });
      return true;
    }
    if (window.count >= RATE_LIMIT) return false;
    window.count += 1;
    return true;
  }

  // Drops expired windows. If every tracked window is still active the whole map
  // is cleared, which only resets best-effort limits and keeps memory bounded.
  private prune(now: number): void {
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
    if (this.windows.size >= MAX_TRACKED_NETWORKS) this.windows.clear();
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
