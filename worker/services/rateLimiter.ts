// Durable Object backed rate limiter.
//
// Counters are persisted in the Durable Object's private storage so an idle
// object that gets evicted does not lose its state; an attacker cannot reset a
// quota by pausing. Storage keys are keyed hashes or `user:<id>` and never leave
// the platform. The read-modify-write runs inside `blockConcurrencyWhile` so
// concurrent requests for the same key cannot interleave. An alarm evicts
// expired keys and is only re-armed when a new reset time is earlier than the
// one already scheduled (tracked in memory).

interface RateLimitRequest {
  key: string;
  limit: number;
  windowMs: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  // In-memory view of the currently scheduled alarm so a call does not need a
  // storage read just to decide whether to re-arm.
  private nextAlarmAt = 0;

  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    let body: RateLimitRequest;
    try {
      body = await request.json() as RateLimitRequest;
    } catch {
      return Response.json({ message: 'invalid JSON' }, { status: 400 });
    }

    const key = String(body.key ?? '');
    const limit = Number(body.limit ?? 0);
    const windowMs = Number(body.windowMs ?? 0);
    if (!key || !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1) {
      return Response.json({ message: 'invalid rate limit request' }, { status: 400 });
    }

    const result = await this.state.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const stored = await this.state.storage.get<Bucket>(key);
      const bucket: Bucket = stored && stored.resetAt > now ? stored : { count: 0, resetAt: now + windowMs };

      if (bucket.count >= limit) {
        return { allowed: false, remaining: 0, resetAt: bucket.resetAt };
      }

      bucket.count += 1;
      await this.state.storage.put(key, bucket);
      return { allowed: true, remaining: Math.max(0, limit - bucket.count), resetAt: bucket.resetAt };
    });

    await this.scheduleAlarm(result.resetAt);
    return Response.json(result);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const entries = await this.state.storage.list<Bucket>();
    this.nextAlarmAt = 0;
    for (const [key, bucket] of entries) {
      if (bucket.resetAt <= now) {
        await this.state.storage.delete(key);
      } else if (this.nextAlarmAt === 0 || bucket.resetAt < this.nextAlarmAt) {
        this.nextAlarmAt = bucket.resetAt;
      }
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