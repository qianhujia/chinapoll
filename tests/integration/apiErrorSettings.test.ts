// Error codes for the responses that depend on a stored setting. The settings
// are written before the first request so the Worker's per-isolate settings
// cache (30s) picks them up; that is why these live in their own file.

import { beforeAll, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { ORIGIN, applySchema, seedPoll } from './helpers';

beforeAll(async () => {
  await applySchema();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('report_rate_limit', '1/d')"),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('read_only_mode', 'true')")
  ]);
});

describe('api error codes under settings', () => {
  it('codes a rate limit', async () => {
    const pollId = await seedPoll({ title: 'Coded rate limit poll' });
    const report = () => SELF.fetch(`${ORIGIN}/api/polls/${pollId}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ reason: 'spam' })
    });

    expect((await report()).status).toBe(201);
    const limited = await report();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({
      error: { code: 'REPORT_RATE_LIMIT' },
      message: 'report rate limit reached'
    });
  });

  it('codes read-only mode distinctly from a misconfiguration', async () => {
    const pollId = await seedPoll({ title: 'Coded read only poll' });

    const response = await SELF.fetch(`${ORIGIN}/api/vote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ pollId, tokenHash: 'd'.repeat(64), optionIds: [] })
    });
    expect(response.status).toBe(423);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: 'READ_ONLY' },
      message: 'readonly mode enabled'
    });
  });
});
