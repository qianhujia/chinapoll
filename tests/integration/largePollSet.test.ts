// Large poll sets: the queries that take a list of poll ids must stay under D1's
// bound-parameter ceiling (100 per statement) when the list is long. A page is at
// most 100 polls and the hourly snapshot pass covers every open poll, so both can
// cross it as soon as the site has more than 100 open polls.

import { beforeAll, describe, expect, it } from 'vitest';
import { createExecutionContext, createScheduledController, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../worker/index';
import { ORIGIN, applySchema, seedOptions, seedPoll } from './helpers';

// More than one page of polls, and more than D1's 100-parameter ceiling.
const POLL_COUNT = 120;

beforeAll(async () => {
  await applySchema();

  for (let index = 0; index < POLL_COUNT; index += 1) {
    const pollId = await seedPoll({ title: `Large set poll ${index}` });
    // A public number, as an open poll always has one.
    await env.DB.prepare('UPDATE polls SET number = ? WHERE id = ?').bind(pollId, pollId).run();
    await seedOptions(pollId, [
      { position: 1, label: 'First option' },
      { position: 2, label: 'Second option' }
    ]);
  }
});

async function runMaintenance(): Promise<void> {
  const controller = createScheduledController({ scheduledTime: new Date(), cron: '0 * * * *' });
  const ctx = createExecutionContext();
  await worker.scheduled!(controller, env, ctx);
  await waitOnExecutionContext(ctx);
}

describe('a site with more than 100 open polls', () => {
  it('serves a full page of polls', async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/polls?pageSize=100`);
    expect(response.status).toBe(200);

    const body = await response.json() as { polls: unknown[]; total: number };
    expect(body.polls).toHaveLength(100);
    expect(body.total).toBe(POLL_COUNT);
  });

  it('writes a snapshot for every open poll in one maintenance pass', async () => {
    await runMaintenance();

    const snapshots = await env.DB.prepare(
      `SELECT COUNT(DISTINCT poll_id) AS total FROM stats_snapshots
       WHERE poll_id IN (SELECT id FROM polls WHERE status = ?)`
    ).bind(1).first<{ total: number }>();
    expect(Number(snapshots?.total ?? 0)).toBe(POLL_COUNT);
  });
});