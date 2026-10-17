import { beforeAll, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { sha256Hex } from '../../shared/crypto';
import { hashSnapshot, makeSnapshot, serializeOptionCounts } from '../../worker/services/snapshot';
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
        ballots: index,
        views: index,
        prevHash
      });
      prevHash = snapshot.hash;
      batch.push(
        env.DB.prepare(
          'INSERT INTO stats_snapshots (poll_id, ts_hour, ballots, views, prev_hash, hash, final) VALUES (?, ?, ?, ?, ?, ?, 0)'
        ).bind(
          pollId, snapshot.tsHour, snapshot.ballots, snapshot.views,
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

  // A poll stores the per-option counts as JSON. The verify walk must recompute
  // the same hash for those rows, and the stored numbers must be covered by the
  // hash chain.
  it('carries option counts and ballots through the signed chain', async () => {
    const pollId = await seedPoll({ title: 'Choice chain poll', pollType: 2 });
    const first = await makeSnapshot({
      pollId,
      tsHour: 2_000_000,
      ballots: 3,
      optionCounts: [{ position: 1, count: 2 }, { position: 2, count: 1 }],
      views: 5,
      prevHash: null
    });
    const second = await makeSnapshot({
      pollId,
      tsHour: 2_000_001,
      ballots: 4,
      optionCounts: [{ position: 1, count: 2 }, { position: 2, count: 2 }],
      views: 6,
      prevHash: first.hash
    });

    await env.DB.batch([first, second].map((snapshot) => env.DB.prepare(
      `INSERT INTO stats_snapshots
       (poll_id, ts_hour, ballots, option_counts, views, prev_hash, hash, final)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
    ).bind(
      pollId, snapshot.tsHour, snapshot.ballots,
      serializeOptionCounts(snapshot.optionCounts), snapshot.views,
      snapshot.prevHash, snapshot.hash
    )));

    const verify = await (await SELF.fetch(`${ORIGIN}/api/snapshots/${pollId}/verify`)).json() as { valid: boolean; count: number };
    expect(verify.valid).toBe(true);
    expect(verify.count).toBe(2);

    const chain = await (await SELF.fetch(`${ORIGIN}/api/snapshots/${pollId}`)).json() as any;
    expect(chain.schemaVersion).toBe(3);
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

  // A chain written by the version 2 payload carries the three verdict counts next
  // to the ballots and the option counts. Those rows must still verify after the
  // payload moved to version 3.
  it('verifies a stored version 2 chain', async () => {
    const pollId = await seedPoll({ title: 'Version 2 chain poll' });
    let prevHash = 'GENESIS';
    const batch: D1PreparedStatement[] = [];

    for (let index = 0; index < 3; index += 1) {
      const tsHour = 3_000_000 + index;
      const record = {
        pollId,
        tsHour,
        approve: index,
        oppose: 1,
        neutral: 2,
        ballots: index + 3,
        optionCounts: [{ position: 1, count: index }, { position: 2, count: 2 }],
        views: index,
        prevHash
      };
      // The version 2 payload of this record, exactly as it was signed then.
      const hash = await hashSnapshot(record, 2);
      prevHash = hash;
      batch.push(env.DB.prepare(
        `INSERT INTO stats_snapshots
         (poll_id, ts_hour, approve, oppose, neutral, ballots, option_counts, views, prev_hash, hash, final)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
      ).bind(
        pollId, tsHour, record.approve, record.oppose, record.neutral, record.ballots,
        serializeOptionCounts(record.optionCounts), record.views, record.prevHash, hash
      ));
    }
    await env.DB.batch(batch);

    const verify = await (await SELF.fetch(`${ORIGIN}/api/snapshots/${pollId}/verify`)).json() as { valid: boolean; count: number };
    expect(verify.valid).toBe(true);
    expect(verify.count).toBe(3);

    // The published response still reports the counts those records were signed
    // over, so an external verifier can reproduce the version 2 payload.
    const chain = await (await SELF.fetch(`${ORIGIN}/api/snapshots/${pollId}`)).json() as any;
    expect(chain.snapshots[0].approve).toBe(0);
    expect(chain.snapshots[1].approve).toBe(1);
    expect(chain.snapshots[1].oppose).toBe(1);
    expect(chain.snapshots[1].neutral).toBe(2);
    expect(chain.snapshots[1].ballots).toBe(4);

    // Rewriting a version 2 record is still detected.
    await env.DB.prepare('UPDATE stats_snapshots SET approve = 99 WHERE poll_id = ? AND ts_hour = ?')
      .bind(pollId, 3_000_000).run();
    const tampered = await (await SELF.fetch(`${ORIGIN}/api/snapshots/${pollId}/verify`)).json() as { valid: boolean };
    expect(tampered.valid).toBe(false);
  });

  // A chain published before the poll types release has no ballots or option
  // counts. It must still verify, so an old published chain is never reported as
  // tampered with.
  it('verifies a version 1 chain published before the new fields existed', async () => {
    const pollId = await seedPoll({ title: 'Legacy chain poll' });
    let prevHash = 'GENESIS';
    const batch: D1PreparedStatement[] = [];

    for (let index = 0; index < 3; index += 1) {
      // The precise version 1 payload: poll id, hour, the three verdict counts,
      // the cumulative views, and the chain link.
      const tsHour = 4_000_000 + index;
      const link = prevHash;
      const payload = JSON.stringify({
        pollId,
        tsHour,
        approve: index,
        oppose: 0,
        neutral: 0,
        views: index,
        prevHash: link
      });
      const hash = await sha256Hex(`${link}:${payload}`);
      prevHash = hash;
      batch.push(env.DB.prepare(
        `INSERT INTO stats_snapshots
         (poll_id, ts_hour, approve, oppose, neutral, views, prev_hash, hash, final)
         VALUES (?, ?, ?, 0, 0, ?, ?, ?, 0)`
      ).bind(pollId, tsHour, index, index, link, hash));
    }
    await env.DB.batch(batch);

    const verify = await (await SELF.fetch(`${ORIGIN}/api/snapshots/${pollId}/verify`)).json() as { valid: boolean };
    expect(verify.valid).toBe(true);

    // Rewriting a legacy record is still detected.
    await env.DB.prepare('UPDATE stats_snapshots SET approve = 99 WHERE poll_id = ? AND ts_hour = ?')
      .bind(pollId, 4_000_000).run();
    const tampered = await (await SELF.fetch(`${ORIGIN}/api/snapshots/${pollId}/verify`)).json() as { valid: boolean };
    expect(tampered.valid).toBe(false);
  });
});
