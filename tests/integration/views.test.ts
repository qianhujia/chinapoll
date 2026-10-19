import { beforeAll, describe, expect, it } from 'vitest';
import { env, runDurableObjectAlarm, SELF } from 'cloudflare:test';
import { ORIGIN, applySchema, seedPoll, viewRequest } from './helpers';

function todayBucket(): number {
  return Math.floor(Date.now() / 1000 / 86400) * 86400;
}

// The per-poll counter object, whose five-minute alarm flushes the buffered
// count to D1. Tests fire the alarm directly instead of waiting.
function viewCounter(pollId: number): DurableObjectStub {
  return env.VIEW_COUNTER.get(env.VIEW_COUNTER.idFromName(String(pollId)));
}

beforeAll(async () => {
  await applySchema();
});

describe('poll view counting', () => {
  it('records one row per poll per day and answers 204', async () => {
    const pollId = await seedPoll({ title: 'View poll' });

    expect((await viewRequest(pollId)).status).toBe(204);
    expect((await viewRequest(pollId)).status).toBe(204);

    // The two views are buffered in the counter until its alarm flushes them.
    expect(await runDurableObjectAlarm(viewCounter(pollId))).toBe(true);

    const row = await env.DB.prepare('SELECT ts_day, views FROM poll_views WHERE poll_id = ?')
      .bind(pollId).first<{ ts_day: number; views: number }>();
    expect(row?.views).toBe(2);
    expect(row?.ts_day).toBe(todayBucket());
    expect((row?.ts_day ?? 0) % 86400).toBe(0);
  });

  it('answers 204 for a missing poll without writing a row', async () => {
    expect((await viewRequest(999_999)).status).toBe(204);
    // The buffered view is dropped when the flush trips the poll foreign key.
    expect(await runDurableObjectAlarm(viewCounter(999_999))).toBe(true);
    const count = await env.DB.prepare('SELECT COUNT(*) AS total FROM poll_views WHERE poll_id = ?')
      .bind(999_999).first<{ total: number }>();
    expect(count?.total).toBe(0);
  });

  it('hides view totals below min_views_to_display and reveals them above it', async () => {
    const pollId = await seedPoll({ title: 'Visible views poll' });

    let detail = await (await SELF.fetch(`${ORIGIN}/api/polls/${pollId}`)).json() as any;
    expect(detail.views).toBeNull();

    // The default threshold is 20 views; twelve today plus eight yesterday clears it.
    await env.DB.batch([
      env.DB.prepare('INSERT INTO poll_views (poll_id, ts_day, views) VALUES (?, ?, ?)').bind(pollId, todayBucket(), 12),
      env.DB.prepare('INSERT INTO poll_views (poll_id, ts_day, views) VALUES (?, ?, ?)').bind(pollId, todayBucket() - 86400, 8)
    ]);

    detail = await (await SELF.fetch(`${ORIGIN}/api/polls/${pollId}`)).json() as any;
    expect(detail.views).toEqual({ total: 20, last7Days: 20 });

    const listing = await (await SELF.fetch(`${ORIGIN}/api/polls?pageSize=100`)).json() as any;
    const entry = listing.polls.find((item: any) => item.poll.id === pollId);
    expect(entry.views).toEqual({ total: 20, last7Days: 20 });
  });

  it('keeps the long-term rollup out of the last-7-days window', async () => {
    const pollId = await seedPoll({ title: 'Rollup views poll' });
    await env.DB.batch([
      env.DB.prepare('INSERT INTO poll_views (poll_id, ts_day, views) VALUES (?, 0, ?)').bind(pollId, 30),
      env.DB.prepare('INSERT INTO poll_views (poll_id, ts_day, views) VALUES (?, ?, ?)').bind(pollId, todayBucket(), 5)
    ]);

    const detail = await (await SELF.fetch(`${ORIGIN}/api/polls/${pollId}`)).json() as any;
    expect(detail.views.total).toBe(35);
    expect(detail.views.last7Days).toBe(5);
  });
});
