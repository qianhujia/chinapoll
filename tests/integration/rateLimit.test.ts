import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applySchema, choiceVoteRequest, seedOptions, seedPoll } from './helpers';

let pollId = 0;
let optionId = 0;

beforeAll(async () => {
  await applySchema();
  // A one-second window keeps the reset assertion fast. The setting is loaded on
  // the first request, before the cached default can be used.
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('vote_rate_limit', '1/s')").run();
  pollId = await seedPoll({ title: 'Rate limited poll' });
  const options = await seedOptions(pollId, [
    { position: 1, label: 'Yes' },
    { position: 2, label: 'No' }
  ]);
  optionId = options.get(1)!;
});

describe('rate limiting', () => {
  it('exhausts the quota and resets once the window elapses', async () => {
    expect((await choiceVoteRequest(pollId, '1'.repeat(64), [optionId])).status).toBe(200);

    const exhausted = await choiceVoteRequest(pollId, '2'.repeat(64), [optionId]);
    expect(exhausted.status).toBe(429);
    expect(await exhausted.json()).toMatchObject({ ok: false, message: 'rate limit reached' });

    await new Promise((resolve) => setTimeout(resolve, 1200));

    expect((await choiceVoteRequest(pollId, '3'.repeat(64), [optionId])).status).toBe(200);
  });
});
