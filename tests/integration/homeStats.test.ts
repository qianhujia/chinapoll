// The home page hero statistics. The `Polls` total, the `Open polls` total, and
// the paginated list that sits below them must all describe the same set: the
// polls a visitor can actually vote on. A closed, archived, or pending poll is
// therefore left out of every one of them. The client reads the totals from
// `GET /api/polls`, while the server-rendered first paint reads
// `loadHomeSsrData`, so both paths are checked here and must agree.

import { beforeAll, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { PollStatus } from '../../worker/enums';
import { loadHomeSsrData } from '../../worker/services/ssr';
import { ORIGIN, applySchema, seedPoll } from './helpers';

const HIDDEN_TITLES = [
  'A closed poll stays out of the statistics',
  'An archived poll stays out of the statistics',
  'A pending poll stays out of the statistics'
] as const;

beforeAll(async () => {
  await applySchema();
});

// The number of polls the hero statistics should show, read straight from the
// database so the expectation does not depend on the code under test.
async function openPollsInDatabase(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS total FROM polls WHERE status = ?')
    .bind(PollStatus.Open).first<{ total: number }>();
  return Number(row?.total ?? 0);
}

describe('home page statistics', () => {
  it('counts only open polls in the listing totals', async () => {
    await seedPoll({ title: 'An open poll counts toward the statistics' });
    await seedPoll({ title: HIDDEN_TITLES[0], status: PollStatus.Closed, closedAt: 1_700_000_000 });
    await seedPoll({ title: HIDDEN_TITLES[1], status: PollStatus.Archived, closedAt: 1_700_000_000 });
    await seedPoll({ title: HIDDEN_TITLES[2], status: PollStatus.Pending });

    const expected = await openPollsInDatabase();
    const listing = await (await SELF.fetch(`${ORIGIN}/api/polls?pageSize=100`)).json() as any;

    expect(expected).toBeGreaterThanOrEqual(1);
    // The unfiltered `totalPolls` statistic and the list's own `total` are the
    // same open-poll count, so the hero number and the list agree.
    expect(listing.totalPolls).toBe(expected);
    expect(listing.total).toBe(expected);
    expect(listing.totalVotes).toBe(0);
    for (const title of HIDDEN_TITLES) {
      expect(listing.polls.map((entry: any) => entry.poll.title)).not.toContain(title);
    }
  });

  it('counts only open polls in the server-rendered hero', async () => {
    const expected = await openPollsInDatabase();
    const data = await loadHomeSsrData(env.DB, { pageSize: 15, page: 1, query: '', topicSlug: '' });

    expect(expected).toBeGreaterThanOrEqual(1);
    // Both hero totals ignore the non-open polls, so the `Polls` and the
    // `Open polls` figures beside it stay equal.
    expect(data.totalPolls).toBe(expected);
    expect(data.topicTotal).toBe(expected);
    expect(data.totalVotes).toBe(0);
    for (const title of HIDDEN_TITLES) {
      expect(data.polls.map((poll) => poll.title)).not.toContain(title);
    }
  });
});