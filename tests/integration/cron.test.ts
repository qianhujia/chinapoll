import { beforeAll, describe, expect, it } from 'vitest';
import { createExecutionContext, createScheduledController, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../worker/index';
import { ORIGIN, applySchema, seedPoll } from './helpers';

beforeAll(async () => {
  await applySchema();
});

describe('hourly maintenance', () => {
  it('closes a due poll and writes a verifiable terminal snapshot', async () => {
    const now = Math.floor(Date.now() / 1000);
    const pollId = await seedPoll({
      title: 'Closing poll',
      mode: 1,
      status: 1,
      startAt: now - 7200,
      endAt: now - 60
    });
    await env.DB.prepare('INSERT INTO votes (poll_id, voter_token_hash, option, created_at) VALUES (?, ?, 1, unixepoch())')
      .bind(pollId, 'e'.repeat(64)).run();

    const controller = createScheduledController({ scheduledTime: new Date(), cron: '0 * * * *' });
    const ctx = createExecutionContext();
    await worker.scheduled!(controller, env, ctx);
    await waitOnExecutionContext(ctx);

    const poll = await env.DB.prepare('SELECT status FROM polls WHERE id = ?')
      .bind(pollId).first<{ status: number }>();
    expect(poll?.status).toBe(2);

    const terminal = await env.DB.prepare(
      'SELECT approve, final FROM stats_snapshots WHERE poll_id = ? AND final = 1'
    ).bind(pollId).first<{ approve: number; final: number }>();
    expect(terminal?.final).toBe(1);
    expect(terminal?.approve).toBe(1);

    const verify = await (await SELF.fetch(`${ORIGIN}/api/snapshots/${pollId}/verify`)).json() as { valid: boolean };
    expect(verify.valid).toBe(true);
  });
});
