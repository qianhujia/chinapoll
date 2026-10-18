import { beforeAll, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import {
  ORIGIN,
  applySchema,
  choiceVoteRequest,
  insertBallot,
  legacyOptionVoteRequest,
  seedOptions,
  seedPoll,
  seedVerdictTemplatePoll,
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
    // There is no separate counts object: the count lives on each option.
    expect(hidden.counts).toBeUndefined();

    // Nine more ballots reveal the counts and keep one row per option.
    for (let index = 0; index < 9; index += 1) {
      await insertBallot(pollId, TOKENS(100 + index), [ids.get(2)!]);
    }

    const stats = await statsFor(pollId);
    expect(stats.pollType).toBe('single_choice');
    expect(stats.hidden).toBe(false);
    expect(stats.ballots).toBe(10);
    // Every ballot chose the same option, so that row carries all ten counts.
    expect(stats.options.map((option: any) => [option.position, option.count])).toEqual([
      [1, 0], [2, 10], [3, 0]
    ]);
    expect(stats.options[1].label).toBe('Metro');
  });

  it('rejects a ballot with no option, two options, a duplicate, and a verdict label', async () => {
    const pollId = await seedPoll({ title: 'Single choice strictness', pollType: 2 });
    const ids = await seedOptions(pollId, [
      { position: 1, label: 'Yes' },
      { position: 2, label: 'No' }
    ]);

    expect((await choiceVoteRequest(pollId, TOKENS(2), [])).status).toBe(400);
    expect((await choiceVoteRequest(pollId, TOKENS(2), [ids.get(1)!, ids.get(2)!])).status).toBe(400);
    expect((await choiceVoteRequest(pollId, TOKENS(2), [ids.get(1)!, ids.get(1)!])).status).toBe(400);
    // The removed legacy `option` label is not accepted either.
    expect((await legacyOptionVoteRequest(pollId, TOKENS(2), 'approve')).status).toBe(400);
  });

  it('rejects an option that belongs to another poll', async () => {
    const pollId = await seedPoll({ title: 'Single choice foreign option', pollType: 2 });
    const otherId = await seedPoll({ title: 'Single choice other poll', pollType: 2 });
    await seedOptions(pollId, [
      { position: 1, label: 'Yes' },
      { position: 2, label: 'No' }
    ]);
    const foreign = await seedOptions(otherId, [
      { position: 1, label: 'Elsewhere' },
      { position: 2, label: 'Nowhere' }
    ]);

    const response = await choiceVoteRequest(pollId, TOKENS(3), [foreign.get(1)!]);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, message: 'unknown option' });
  });
});

describe('multiple choice polls', () => {
  it('accepts one to seven options per ballot and rejects an empty or duplicate ballot', async () => {
    const pollId = await seedPoll({ title: 'Multi choice poll', pollType: 3 });
    const ids = await seedOptions(pollId, Array.from({ length: 7 }, (_, index) => ({
      position: index + 1,
      label: `Option ${index + 1}`
    })));

    expect((await choiceVoteRequest(pollId, TOKENS(4), [])).status).toBe(400);
    expect((await choiceVoteRequest(pollId, TOKENS(4), [...ids.values()])).status).toBe(200);
    // The same option cannot be selected twice on one ballot.
    expect((await choiceVoteRequest(pollId, TOKENS(5), [ids.get(1)!, ids.get(1)!])).status).toBe(400);

    // One ballot row, seven selection rows.
    const selections = await env.DB.prepare(
      'SELECT COUNT(*) AS total FROM vote_selections WHERE poll_id = ?'
    ).bind(pollId).first<{ total: number }>();
    expect(selections?.total).toBe(7);
  });
});

describe('choice poll responses', () => {
  it('reports the poll type, the options, and the stored ballot', async () => {
    const pollId = await seedPoll({ title: 'Choice response shape', pollType: 2 });
    const ids = await seedOptions(pollId, [
      { position: 1, label: 'Keep' },
      { position: 2, label: 'Change' }
    ]);
    await choiceVoteRequest(pollId, TOKENS(6), [ids.get(1)!]);

    const detail = await (await SELF.fetch(`${ORIGIN}/api/polls/${pollId}`)).json() as any;
    expect(detail.poll.pollType).toBe('single_choice');
    expect(detail.poll.options).toEqual([
      { id: ids.get(1), label: 'Keep', position: 1 },
      { id: ids.get(2), label: 'Change', position: 2 }
    ]);

    const listing = await listingFor(pollId);
    expect(listing.poll.pollType).toBe('single_choice');
    expect(listing.poll.options).toHaveLength(2);
    expect(listing.stats.pollType).toBe('single_choice');
    expect(listing.stats.ballots).toBe(1);
    expect(listing.stats.counts).toBeUndefined();
    // The options are hidden below the display threshold, so no count is shown.
    expect(listing.stats.options).toBeNull();

    const status = await (await voteStatusRequest(pollId, TOKENS(6))).json() as any;
    expect(status.voted).toBe(true);
    expect(status.optionIds).toEqual([ids.get(1)]);

    const noVote = await (await voteStatusRequest(pollId, TOKENS(7))).json() as any;
    expect(noVote.voted).toBe(false);
    expect(noVote.optionIds).toEqual([]);
  });

  it('treats a verdict poll as its own type with single choice ballots', async () => {
    // The verdict type is stored on its own and pre-fills three labels, but it
    // takes exactly one option per ballot like a single choice poll.
    const { pollId, options } = await seedVerdictTemplatePoll({ title: 'Verdict response' });
    await choiceVoteRequest(pollId, TOKENS(8), [options.get(3)!]);

    const detail = await (await SELF.fetch(`${ORIGIN}/api/polls/${pollId}`)).json() as any;
    expect(detail.poll.pollType).toBe('verdict');
    expect(detail.poll.options).toEqual([
      { id: options.get(1), label: 'Approve', position: 1 },
      { id: options.get(2), label: 'Neutral', position: 2 },
      { id: options.get(3), label: 'Oppose', position: 3 }
    ]);

    // Two options in one ballot are refused, exactly as on a single choice poll.
    const twoOptions = await choiceVoteRequest(pollId, TOKENS(9), [options.get(1)!, options.get(3)!]);
    expect(twoOptions.status).toBe(400);

    const stats = await statsFor(pollId);
    expect(stats.pollType).toBe('verdict');
    // One ballot is below the default threshold of 10, so every option count is
    // withheld while the ballot total is still reported.
    expect(stats.ballots).toBe(1);
    expect(stats.hidden).toBe(true);
    expect(stats.options).toBeNull();

    const status = await (await voteStatusRequest(pollId, TOKENS(8))).json() as any;
    expect(status.voted).toBe(true);
    expect(status.optionIds).toEqual([options.get(3)!]);
  });
});
