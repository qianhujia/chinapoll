import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applySchema, seedPoll, voteRequest } from './helpers';

let pollId = 0;

beforeAll(async () => {
  await applySchema();
  // A one-second window keeps the reset assertion fast. The setting is loaded on
  // the first request, before the cached default can be used.
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('vote_rate_limit', '1/s')").run();
  pollId = await seedPoll({ title: 'Rate limited poll' });
});

describe('rate limiting', () => {
  it('exhausts the quota and resets once the window elapses', async () => {
    expect((await voteRequest(pollId, '1'.repeat(64))).status).toBe(200);

    const exhausted = await voteRequest(pollId, '2'.repeat(64));
    expect(exhausted.status).toBe(429);
    expect(await exhausted.json()).toMatchObject({ ok: false, message: 'rate limit reached' });

    await new Promise((resolve) => setTimeout(resolve, 1200));

    expect((await voteRequest(pollId, '3'.repeat(64))).status).toBe(200);
  });
});
