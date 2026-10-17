import { beforeAll, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { makeSnapshot } from '../../worker/services/snapshot';
import { ORIGIN, applySchema, seedPoll } from './helpers';

beforeAll(async () => {
  await applySchema();
});

describe('snapshot chain', () => {
  it('verifies a chain longer than one API page', async () => {
    const pollId = await seedPoll({ title: 'Long chain poll' });
    let prevHash: string | null = null;
    let batch: D1PreparedStatement[] = [];

    for (let index = 0; index < 600; index += 1) {
      const snapshot = await makeSnapshot({
        pollId,
        tsHour: 1_000_000 + index,
        counts: { approve: index, oppose: 0, neutral: 0 },
        views: index,
        prevHash
      });
      prevHash = snapshot.hash;
      batch.push(
        env.DB.prepare(
          'INSERT INTO stats_snapshots (poll_id, ts_hour, approve, oppose, neutral, views, prev_hash, hash, final) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)'
        ).bind(pollId, snapshot.tsHour, snapshot.approve, snapshot.oppose, snapshot.neutral, snapshot.views, snapshot.prevHash, snapshot.hash)
      );
      if (batch.length === 100) {
        await env.DB.batch(batch);
        batch = [];
      }
    }
    if (batch.length > 0) await env.DB.batch(batch);

    const verify = await (await SELF.fetch(`${ORIGIN}/api/snapshots/${pollId}/verify`)).json() as { valid: boolean; count: number };
    expect(verify.valid).toBe(true);
    expect(verify.count).toBe(600);
  });
});
