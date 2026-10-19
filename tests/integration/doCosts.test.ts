// Durable Object cost boundaries: the write and request counts that decide
// whether the free plan holds.
//
// The rate limiter and the view counter are instantiated directly with a fake
// state that counts storage writes and alarm arms, so each assertion is exact.

import { beforeAll, describe, expect, it } from 'vitest';
import { env, listDurableObjectIds } from 'cloudflare:test';
import { RateLimiter } from '../../worker/services/rateLimiter';
import { ViewCounter, type ViewCounterEnv } from '../../worker/services/viewCounter';
import { hashPassword, passwordHasherShard, verifyPassword } from '../../worker/services/passwordHasher';
import { applySchema, seedPoll, viewRequest } from './helpers';

beforeAll(async () => {
  await applySchema();
});

interface StorageCounts {
  puts: number;
  alarmSets: number;
}

interface FakeStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<Map<string, unknown>>;
  setAlarm(time: number): Promise<void>;
  getAlarm(): Promise<number | null>;
  transaction<T>(closure: (txn: FakeStorage) => Promise<T>): Promise<T>;
}

// A stand-in Durable Object state that counts storage writes and alarm arms.
function countingState(idName = '1'): { state: DurableObjectState; counts: StorageCounts } {
  const store = new Map<string, unknown>();
  const counts: StorageCounts = { puts: 0, alarmSets: 0 };
  let alarm: number | null = null;
  const storage: FakeStorage = {
    async get(key: string) { return store.get(key); },
    async put(key: string, value: unknown) { counts.puts += 1; store.set(key, value); },
    async delete(key: string) { store.delete(key); },
    async list() { return new Map(store); },
    async setAlarm(time: number) { counts.alarmSets += 1; alarm = time; },
    async getAlarm() { return alarm; },
    async transaction<T>(closure: (txn: FakeStorage) => Promise<T>): Promise<T> {
      return closure(storage);
    }
  };
  const state = { id: { name: idName }, storage } as unknown as DurableObjectState;
  return { state, counts };
}

function rateRequest(key: string, limit: number, windowMs: number): Request {
  return new Request('https://rate-limiter.internal/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, limit, windowMs })
  });
}

function counterRequest(pollId: number, ipHash: string): Request {
  return new Request('https://view-counter.internal/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pollId, ipHash })
  });
}

describe('durable object cost', () => {
  it('rate limiter writes a bucket only on a window start and threshold crossings', async () => {
    const { state, counts } = countingState();
    const limiter = new RateLimiter(state);

    for (let index = 0; index < 50; index += 1) {
      const response = await limiter.fetch(rateRequest('net', 100, 3_600_000));
      expect((await response.json() as { allowed: boolean }).allowed).toBe(true);
    }

    // Fifty requests against one window persist at counts 1, 10, 20, 30, 40, and
    // 50, and arm the eviction alarm once.
    expect(counts.puts).toBe(6);
    expect(counts.alarmSets).toBe(1);
  });

  it('view counter checks its own in-memory rate limit and writes nothing on the request path', async () => {
    const { state, counts } = countingState('7');
    const counter = new ViewCounter(state, env as unknown as ViewCounterEnv);

    for (let index = 0; index < 60; index += 1) {
      const body = await (await counter.fetch(counterRequest(7, 'network-hash'))).json() as { counted: boolean };
      expect(body.counted).toBe(true);
    }
    // The 61st view is over the in-memory limit and is not counted.
    const over = await (await counter.fetch(counterRequest(7, 'network-hash'))).json() as { counted: boolean };
    expect(over.counted).toBe(false);

    // Neither the counting nor the rate limit writes a storage row.
    expect(counts.puts).toBe(0);
  });

  it('view counter flushes the buffered count once on the alarm', async () => {
    const pollId = await seedPoll({ title: 'Cost flush poll' });
    const { state, counts } = countingState(String(pollId));
    const counter = new ViewCounter(state, env as unknown as ViewCounterEnv);

    for (let index = 0; index < 3; index += 1) {
      await counter.fetch(counterRequest(pollId, 'network-hash'));
    }
    expect(counts.puts).toBe(0);

    await counter.alarm();

    const row = await env.DB.prepare('SELECT views FROM poll_views WHERE poll_id = ?')
      .bind(pollId).first<{ views: number }>();
    expect(row?.views).toBe(3);
  });

  it('spreads password hashing across username-derived shards', async () => {
    const shards = new Set<string>();
    for (let index = 0; index < 64; index += 1) shards.add(await passwordHasherShard(`user-${index}`));
    expect(shards.size).toBeGreaterThan(1);
    expect(shards.size).toBeLessThanOrEqual(16);

    // A username always maps to the same shard, and the object at that shard
    // round-trips the hash.
    expect(await passwordHasherShard('alice')).toBe(await passwordHasherShard('alice'));
    const hash = await hashPassword(env, 'alice', 'test-password-123');
    expect(await verifyPassword(env, 'alice', 'test-password-123', hash)).toBe(true);
    expect(await verifyPassword(env, 'alice', 'wrong-password-123', hash)).toBe(false);

    // Only a bounded number of shard objects exist.
    const instances = await listDurableObjectIds(env.PASSWORD_HASHER);
    expect(instances.length).toBeGreaterThanOrEqual(1);
    expect(instances.length).toBeLessThanOrEqual(16);
  });

  it('records a page view without creating a rate limiter object', async () => {
    const pollId = await seedPoll({ title: 'Cost page view poll' });
    expect((await viewRequest(pollId)).status).toBe(204);
    // One object request per page view, and no second call to the rate limiter.
    expect(await listDurableObjectIds(env.RATE_LIMITER)).toHaveLength(0);
  });
});
