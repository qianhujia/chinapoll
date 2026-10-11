// Durable Object backed rate limiter.
//
// Counters live in memory only. Nothing about a caller is written to storage, so
// the limiter cannot leak origin data and the counter update is atomic because a
// single Durable Object handles one key space serially. An alarm evicts expired
// keys so the in-memory map stays bounded.

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
  private buckets = new Map<string, Bucket>();

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

    const now = Date.now();
    const existing = this.buckets.get(key);
    const bucket: Bucket = existing && existing.resetAt > now ? existing : { count: 0, resetAt: now + windowMs };

    if (bucket.count >= limit) {
      this.scheduleEviction(bucket.resetAt);
      return Response.json({ allowed: false, remaining: 0, resetAt: bucket.resetAt });
    }

    bucket.count += 1;
    this.buckets.set(key, bucket);
    this.scheduleEviction(bucket.resetAt);
    return Response.json({ allowed: true, remaining: Math.max(0, limit - bucket.count), resetAt: bucket.resetAt });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    let nextReset = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
      } else {
        nextReset = Math.min(nextReset, bucket.resetAt);
      }
    }
    if (Number.isFinite(nextReset)) {
      await this.state.storage.setAlarm(nextReset);
    }
  }

  private scheduleEviction(resetAt: number): void {
    // Best-effort: if an alarm is already set further out it is left in place.
    void this.state.storage.getAlarm().then((current) => {
      if (current === null || current > resetAt) {
        return this.state.storage.setAlarm(resetAt);
      }
      return undefined;
    });
  }
}