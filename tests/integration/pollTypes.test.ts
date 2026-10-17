import { beforeAll, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import {
  ORIGIN,
  applySchema,
  choiceVoteRequest,
  seedOptions,
  seedPoll,
  voteRequest,
  voteStatusRequest
} from './helpers';

beforeAll(async () => {
  await applySchema();
  // The functional tests below cast more than the default 5/h vote limit; the
  // rate-limit behaviour itself is covered in rateLimit.test.ts.
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('vote_rate_limit', '1000/h')").run();
});

const TOKENS = (index: number) => String(index).padStart(64, 'a');

async function statsFor(pollId: number): Promise<any> {
  return (await SELF.fetch(`${ORIGIN}/api/stats/${pollId}`)).json();
}

async function listingFor(pollId: number): Promise<any> {
  const listing = await (await SELF.fetch(`${ORIGIN}/api/polls?pageSize=100`)).json() as any;
  return listing.polls.find((entry: any) => entry.poll.id === pollId);
}

describe('single choice polls', () => {
  it('accepts exactly one option and reports per-option counts', async () => {
    const pollId = await seedPoll({ title: 'Single choice poll', pollType: 2 });
    const ids = await seedOptions(pollId, [
      { position: 1, label: 'Bus' },
      { position: 2, label: 'Metro' },
      { position: 3, label: 'Bike' }
    ]);

    const response = await choiceVoteRequest(pollId, TOKENS(1), [ids.get(2)!]);
    expect(response.status).toBe(200);
    // The default display threshold is 10 ballots, so the first ballot is hidden.
    const hidden = await response.json() as any;
    expect(hidden.pollType).toBe('single_choice');
    expect(hidden.options).toBeNull();
    expect(hidden.ballots).toBe(1);
    expect(hidden.hidden).toBe(true);
    // The legacy verdict counts are not part of a choice response.
    expect(hidden.counts).toBeNull();

    // Nine more ballots reveal the counts and keep one row per option.
    const statements = [];
    for (let index = 0; index < 9; index += 1) {
      statements.push(
        env.DB.prepare('INSERT INTO votes (poll_id, voter_token_hash, option, created_at) VALUES (?, ?, NULL, unixepoch())')
          .bind(pollId, TOKENS(100 + index))
      );
    }
    await env.DB.batch(statements);

    const stats = await statsFor(pollId);
    expect(stats.pollType).toBe('single_choice');
    expect(stats.hidden).toBe(false);
    expect(stats.ballots).toBe(10);
    // Only the first ballot has a selection, so one option carries one count.
    expect(stats.options.map((option: any) => [option.position, option.count, option.virtual])).toEqual([
      [1, 0, false], [2, 1, false], [3, 0, false]
    ]);
    expect(stats.options[1].label).toBe('Metro');
  });

  it('rejects a ballot with no option, two options, a duplicate, and a verdict', async () => {
    const pollId = await seedPoll({ title: 'Single choice strictness', pollType: 2 });
    const ids = await seedOptions(pollId, [
      { position: 1, label: 'Yes' },
      { position: 2, label: 'No' }
    ]);

    expect((await choiceVoteRequest(pollId, TOKENS(2), [])).status).toBe(400);
    expect((await choiceVoteRequest(pollId, TOKENS(2), [ids.get(1)!, ids.get(2)!])).status).toBe(400);
    expect((await choiceVoteRequest(pollId, TOKENS(2), [ids.get(1)!, ids.get(1)!])).status).toBe(400);
    // A verdict is not accepted on a choice poll.
    expect((await voteRequest(pollId, TOKENS(2), 'approve')).status).toBe(400);
  });

  it('rejects an option that belongs to another poll', async () => {
    const pollId = await seedPoll({ title: 'Ownership check', pollType: 2 });
    await seedOptions(pollId, [
      { position: 1, label: 'A' },
      { position: 2, label: 'B' }
    ]);
    const otherPoll = await seedPoll({ title: 'Other choice poll', pollType: 2 });
    const otherIds = await seedOptions(otherPoll, [
      { position: 1, label: 'C' },
      { position: 2, label: 'D' }
    ]);

    expect((await choiceVoteRequest(pollId, TOKENS(2), [otherIds.get(1)!])).status).toBe(400);
    // A missing option id is rejected as well.
    expect((await choiceVoteRequest(pollId, TOKENS(2), [999_999])).status).toBe(400);
  });

  it('rejects option ids on a verdict poll and keeps one ballot per token', async () => {
    const pollId = await seedPoll({ title: 'Verdict strictness' });
    const choicePoll = await seedPoll({ title: 'Unrelated choice', pollType: 2 });
    const ids = await seedOptions(choicePoll, [
      { position: 1, label: 'A' },
      { position: 2, label: 'B' }
    ]);

    // A verdict poll accepts one virtual ID, one legacy label, or both in
    // agreement; anything else is refused.
    expect((await choiceVoteRequest(pollId, TOKENS(3), [ids.get(1)!])).status).toBe(400);
    expect((await choiceVoteRequest(pollId, TOKENS(3), [1, 2])).status).toBe(400);
    expect((await choiceVoteRequest(pollId, TOKENS(3), [1])).status).toBe(200);
    expect((await voteRequest(pollId, TOKENS(3), 'oppose')).status).toBe(409);

    expect((await choiceVoteRequest(choicePoll, TOKENS(4), [ids.get(1)!])).status).toBe(200);
    // The unique index still enforces one ballot per (poll, token) even though
    // the option column is NULL for a choice ballot.
    expect((await choiceVoteRequest(choicePoll, TOKENS(4), [ids.get(2)!])).status).toBe(409);
  });
});

describe('multi choice polls', () => {
  it('accepts several options and stores one selection row per option', async () => {
    const pollId = await seedPoll({ title: 'Multi choice poll', pollType: 3 });
    const ids = await seedOptions(pollId, [
      { position: 1, label: 'Roads' },
      { position: 2, label: 'Rail' },
      { position: 3, label: 'Buses' }
    ]);

    const response = await choiceVoteRequest(pollId, TOKENS(5), [ids.get(3)!, ids.get(1)!]);
    expect(response.status).toBe(200);

    const stats = await statsFor(pollId);
    expect(stats.counts).toBeNull();
    expect(stats.hidden).toBe(true);

    const selections = await env.DB.prepare(
      `SELECT o.position FROM vote_selections vs
       JOIN poll_options o ON o.id = vs.option_id
       WHERE vs.vote_id = (SELECT id FROM votes WHERE poll_id = ? AND voter_token_hash = ?)
       ORDER BY o.position ASC`
    ).bind(pollId, TOKENS(5)).all<{ position: number }>();
    expect(selections.results?.map((row) => Number(row.position))).toEqual([1, 3]);
  });

  it('accepts up to seven distinct options and rejects an empty ballot', async () => {
    const pollId = await seedPoll({ title: 'Multi choice limits', pollType: 3 });
    const ids = await seedOptions(pollId, Array.from({ length: 7 }, (_, index) => ({
      position: index + 1,
      label: `Option ${index + 1}`
    })));

    expect((await choiceVoteRequest(pollId, TOKENS(6), [])).status).toBe(400);
    expect((await choiceVoteRequest(pollId, TOKENS(6), [...ids.values()])).status).toBe(200);
    expect((await choiceVoteRequest(pollId, TOKENS(7), [ids.get(1)!, ids.get(1)!])).status).toBe(400);
  });
});

describe('choice poll responses', () => {
  it('reports the poll type, the options, and the stored ballot', async () => {
    const pollId = await seedPoll({ title: 'Choice response shape', pollType: 2 });
    const ids = await seedOptions(pollId, [
      { position: 1, label: 'Keep' },
      { position: 2, label: 'Change' }
    ]);
    await choiceVoteRequest(pollId, TOKENS(8), [ids.get(1)!]);

    const detail = await (await SELF.fetch(`${ORIGIN}/api/polls/${pollId}`)).json() as any;
    expect(detail.poll.pollType).toBe('single_choice');
    expect(detail.poll.options).toEqual([
      { id: ids.get(1), label: 'Keep', position: 1, virtual: false },
      { id: ids.get(2), label: 'Change', position: 2, virtual: false }
    ]);

    const listing = await listingFor(pollId);
    expect(listing.poll.pollType).toBe('single_choice');
    expect(listing.poll.options).toHaveLength(2);
    expect(listing.stats.pollType).toBe('single_choice');
    expect(listing.stats.ballots).toBe(1);
    expect(listing.stats.counts).toBeNull();

    const status = await (await voteStatusRequest(pollId, TOKENS(8))).json() as any;
    expect(status.voted).toBe(true);
    expect(status.option).toBeNull();
    expect(status.optionIds).toEqual([ids.get(1)]);

    const noVote = await (await voteStatusRequest(pollId, TOKENS(9))).json() as any;
    expect(noVote.voted).toBe(false);
    expect(noVote.optionIds).toEqual([]);
  });

  it('reports the three virtual options and an optionIds ballot for a verdict poll', async () => {
    const pollId = await seedPoll({ title: 'Verdict response shape' });
    await voteRequest(pollId, TOKENS(10), 'oppose');
    // A verdict can also be cast as one virtual option ID.
    await choiceVoteRequest(pollId, TOKENS(11), [2]);

    const detail = await (await SELF.fetch(`${ORIGIN}/api/polls/${pollId}`)).json() as any;
    expect(detail.poll.pollType).toBe('verdict');
    // The three entries are virtual and carry i18n keys as their labels.
    expect(detail.poll.options).toEqual([
      { id: 1, label: 'approve', position: 1, virtual: true },
      { id: 3, label: 'neutral', position: 2, virtual: true },
      { id: 2, label: 'oppose', position: 3, virtual: true }
    ]);

    const stats = await statsFor(pollId);
    expect(stats.pollType).toBe('verdict');
    // The same results shape as a choice poll, plus the legacy counts. Two
    // ballots are below the default threshold of 10, so every option count is
    // withheld while the ballot total is still reported.
    expect(stats.ballots).toBe(2);
    expect(stats.hidden).toBe(true);
    expect(stats.options).toBeNull();
    expect(stats.counts).toBeNull();

    // Both spellings of the verdict resolve to the same stored code.
    const byLabel = await (await voteStatusRequest(pollId, TOKENS(10))).json() as any;
    expect(byLabel.option).toBe('oppose');
    expect(byLabel.optionIds).toEqual([2]);
    const byId = await (await voteStatusRequest(pollId, TOKENS(11))).json() as any;
    expect(byId.option).toBe('oppose');
    expect(byId.optionIds).toEqual([2]);
  });
});
