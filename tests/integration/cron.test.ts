import { beforeAll, describe, expect, it } from 'vitest';
import { createExecutionContext, createScheduledController, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../worker/index';
import { ORIGIN, applySchema, insertBallot, seedOptions, seedPoll } from './helpers';

beforeAll(async () => {
  await applySchema();
});

// Runs the hourly scheduled handler once, as the cron trigger does.
async function runMaintenance(): Promise<void> {
  const controller = createScheduledController({ scheduledTime: new Date(), cron: '0 * * * *' });
  const ctx = createExecutionContext();
  await worker.scheduled!(controller, env, ctx);
  await waitOnExecutionContext(ctx);
}

async function rowCounts(pollId: number): Promise<{ ballots: number; selections: number }> {
  const ballots = await env.DB.prepare('SELECT COUNT(*) AS total FROM votes WHERE poll_id = ?')
    .bind(pollId).first<{ total: number }>();
  const selections = await env.DB.prepare('SELECT COUNT(*) AS total FROM vote_selections WHERE poll_id = ?')
    .bind(pollId).first<{ total: number }>();
  return { ballots: Number(ballots?.total ?? 0), selections: Number(selections?.total ?? 0) };
}

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
    const options = await seedOptions(pollId, [
      { position: 1, label: 'Approve' },
      { position: 2, label: 'Oppose' }
    ]);
    await insertBallot(pollId, 'e'.repeat(64), [options.get(1)!]);

    await runMaintenance();

    const poll = await env.DB.prepare('SELECT status FROM polls WHERE id = ?')
      .bind(pollId).first<{ status: number }>();
    expect(poll?.status).toBe(2);

    // The snapshot carries the ballots and the per-option counts.
    const terminal = await env.DB.prepare(
      'SELECT ballots, option_counts, final FROM stats_snapshots WHERE poll_id = ? AND final = 1'
    ).bind(pollId).first<{ ballots: number; option_counts: string; final: number }>();
    expect(terminal?.final).toBe(1);
    expect(terminal?.ballots).toBe(1);
    expect(JSON.parse(terminal?.option_counts ?? '[]')).toEqual([
      { position: 1, count: 1 },
      { position: 2, count: 0 }
    ]);

    const verify = await (await SELF.fetch(`${ORIGIN}/api/snapshots/${pollId}/verify`)).json() as { valid: boolean };
    expect(verify.valid).toBe(true);
  });

  it('purges expired ballots and their selections together', async () => {
    const now = Math.floor(Date.now() / 1000);
    // Closed 31 days ago, so it is past the 30-day retention window.
    const pollId = await seedPoll({
      title: 'Purged poll',
      mode: 1,
      status: 2,
      closedAt: now - 31 * 86_400,
      endAt: now - 31 * 86_400,
      durationSeconds: 86_400
    });
    const options = await seedOptions(pollId, [
      { position: 1, label: 'Approve' },
      { position: 2, label: 'Oppose' }
    ]);
    await insertBallot(pollId, 'p'.repeat(64), [options.get(1)!, options.get(2)!]);
    expect(await rowCounts(pollId)).toEqual({ ballots: 1, selections: 2 });

    await runMaintenance();

    // The ballot rows are gone and the foreign key cascade removed their
    // selections as well.
    expect(await rowCounts(pollId)).toEqual({ ballots: 0, selections: 0 });
  });
});
