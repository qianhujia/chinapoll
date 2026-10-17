import { beforeAll, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { makeSnapshot, serializeOptionCounts } from '../../worker/services/snapshot';
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
          'INSERT INTO stats_snapshots (poll_id, ts_hour, approve, oppose, neutral, ballots, views, prev_hash, hash, final) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)'
        ).bind(
          pollId, snapshot.tsHour, snapshot.approve, snapshot.oppose,
          snapshot.neutral, snapshot.ballots, snapshot.views,
          snapshot.prevHash, snapshot.hash
        )
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

  // A choice poll stores the per-option counts as JSON. The verify walk must
  // recompute the same hash for those rows, and the stored numbers must be
  // covered by the hash chain.
  it('carries option counts and ballots through the signed chain', async () => {
    const pollId = await seedPoll({ title: 'Choice chain poll', pollType: 2 });
    const first = await makeSnapshot({
      pollId,
      tsHour: 2_000_000,
      counts: { approve: 0, oppose: 0, neutral: 0 },
      ballots: 3,
      optionCounts: [{ position: 1, count: 2 }, { position: 2, count: 1 }],
      views: 5,
      prevHash: null
    });
    const second = await makeSnapshot({
      pollId,
      tsHour: 2_000_001,
      counts: { approve: 0, oppose: 0, neutral: 0 },
      ballots: 4,
      optionCounts: [{ position: 1, count: 2 }, { position: 2, count: 2 }],
      views: 6,
      prevHash: first.hash
    });

    await env.DB.batch([first, second].map((snapshot) => env.DB.prepare(
      `INSERT INTO stats_snapshots
       (poll_id, ts_hour, approve, oppose, neutral, ballots, option_counts, views, prev_hash, hash, final)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).bind(
      pollId, snapshot.tsHour, snapshot.approve, snapshot.oppose, snapshot.neutral,
      snapshot.ballots, serializeOptionCounts(snapshot.optionCounts), snapshot.views,
      snapshot.prevHash, snapshot.hash
    )));

    const verify = await (await SELF.fetch(`${ORIGIN}/api/snapshots/${pollId}/verify`)).json() as { valid: boolean; count: number };
    expect(verify.valid).toBe(true);
    expect(verify.count).toBe(2);

    const chain = await (await SELF.fetch(`${ORIGIN}/api/snapshots/${pollId}`)).json() as any;
    expect(chain.snapshots[0].ballots).toBe(3);
    expect(chain.snapshots[0].optionCounts).toEqual([{ position: 1, count: 2 }, { position: 2, count: 1 }]);
    expect(chain.snapshots[1].ballots).toBe(4);
    expect(chain.snapshots[1].optionCounts).toEqual([{ position: 1, count: 2 }, { position: 2, count: 2 }]);

    // Rewriting one stored option count breaks the chain.
    await env.DB.prepare('UPDATE stats_snapshots SET option_counts = ? WHERE poll_id = ? AND ts_hour = ?')
      .bind(JSON.stringify([{ position: 1, count: 3 }, { position: 2, count: 1 }]), pollId, 2_000_000).run();
    const tampered = await (await SELF.fetch(`${ORIGIN}/api/snapshots/${pollId}/verify`)).json() as { valid: boolean };
    expect(tampered.valid).toBe(false);
  });
});
