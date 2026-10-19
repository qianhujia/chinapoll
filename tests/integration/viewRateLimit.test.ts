import { beforeAll, describe, expect, it } from 'vitest';
import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { applySchema, seedPoll, viewRequest } from './helpers';

beforeAll(async () => {
  await applySchema();
});

describe('view rate limit', () => {
  it('answers 204 even after the 60/h limit is hit', async () => {
    const pollId = await seedPoll({ title: 'View limit poll' });

    for (let index = 0; index < 60; index += 1) {
      expect((await viewRequest(pollId)).status).toBe(204);
    }

    // The 61st request is over the limit but still answers 204 so the response
    // reveals nothing, and no extra view is counted.
    expect((await viewRequest(pollId)).status).toBe(204);

    // Flush the buffered count so the D1 row reflects the sixty counted views.
    const counter = env.VIEW_COUNTER.get(env.VIEW_COUNTER.idFromName(String(pollId)));
    expect(await runDurableObjectAlarm(counter)).toBe(true);

    const row = await env.DB.prepare('SELECT views FROM poll_views WHERE poll_id = ?')
      .bind(pollId).first<{ views: number }>();
    expect(row?.views).toBe(60);
  });
});
