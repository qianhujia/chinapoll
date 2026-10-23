// Durable Object backed rate limiter.
//
// Counters live in the object's memory and are backed by its private storage, so
// an idle object that gets evicted resumes from the last persisted count; an
// attacker cannot reset a quota by pausing. Storage keys are keyed hashes or
// `user:<id>` and never leave the platform. Durable Object requests run one at a
// time, so the in-memory counter is authoritative and needs no storage
// transaction.
//
// Storage writes are kept low: a bucket is written only when its window starts,
// when the count crosses a multiple of PERSIST_STEP, or when it reaches the
// limit, and the eviction alarm is armed once per window. The persisted count can
// therefore lag the real count by at most PERSIST_STEP - 1, which only loosens a
// limit after an eviction, never tightens it.


import { apiError } from '../../shared/http';
interface RateLimitRequest {
  key: string;
  limit: number;
  windowMs: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

// How often a live counter is written back to storage.
const PERSIST_STEP = 10;

export class RateLimiter {
  // In-memory view of the currently scheduled alarm so a call does not need a
  // storage read just to decide whether to re-arm.
  private nextAlarmAt = 0;
  // Authoritative counters, kept in memory. A key is read from storage the first
  // time it is seen in this object's lifetime, so an eviction resumes from the
  // last persisted count (at most PERSIST_STEP - 1 behind).
  private readonly buckets = new Map<string, Bucket>();

  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    let body: RateLimitRequest;
    try {
      body = await request.json() as RateLimitRequest;
    } catch {
      return apiError('INVALID_JSON', 400);
    }

    const key = String(body.key ?? '');
    const limit = Number(body.limit ?? 0);
    const windowMs = Number(body.windowMs ?? 0);
    if (!key || !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1) {
      return apiError('INVALID_RATE_LIMIT_REQUEST', 400);
    }

    // Durable Object requests run one at a time, so the in-memory map can be
    // updated without a storage transaction.
    const now = Date.now();
    let bucket = this.buckets.get(key);
    let newWindow = false;
    if (!bucket) {
      const stored = await this.state.storage.get<Bucket>(key);
      if (stored && stored.resetAt > now) {
        bucket = stored;
      } else {
        bucket = { count: 0, resetAt: now + windowMs };
        newWindow = true;
      }
      this.buckets.set(key, bucket);
    } else if (bucket.resetAt <= now) {
      bucket.count = 0;
      bucket.resetAt = now + windowMs;
      newWindow = true;
    }

    if (bucket.count >= limit) {
      return Response.json({ allowed: false, remaining: 0, resetAt: bucket.resetAt });
    }

    bucket.count += 1;
    if (newWindow || bucket.count % PERSIST_STEP === 0 || bucket.count >= limit) {
      await this.state.storage.put(key, bucket);
    }
    // The eviction alarm is armed once per window, when the window starts.
    if (newWindow) await this.scheduleAlarm(bucket.resetAt);

    return Response.json({
      allowed: true,
      remaining: Math.max(0, limit - bucket.count),
      resetAt: bucket.resetAt
    });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const entries = await this.state.storage.list<Bucket>();
    this.nextAlarmAt = 0;
    for (const [key, bucket] of entries) {
      if (bucket.resetAt <= now) {
        await this.state.storage.delete(key);
        this.buckets.delete(key);
      } else if (this.nextAlarmAt === 0 || bucket.resetAt < this.nextAlarmAt) {
        this.nextAlarmAt = bucket.resetAt;
      }
    }
    // Drop in-memory windows that expired without their count ever being
    // persisted.
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
    if (this.nextAlarmAt !== 0) {
      await this.state.storage.setAlarm(this.nextAlarmAt);
    }
  }

  private async scheduleAlarm(resetAt: number): Promise<void> {
    if (this.nextAlarmAt !== 0 && this.nextAlarmAt <= resetAt) return;
    this.nextAlarmAt = resetAt;
    await this.state.storage.setAlarm(resetAt);
  }
}
