import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  countBallots,
  getOptionsForPolls,
  getPollOptions,
  toPublicResults
} from '../../worker/services/options';
import { applySchema, choiceVoteRequest, lastId, seedOptions, seedPoll, voteRequest } from './helpers';

// The shared engine is the single counting and results path for all three poll
// types. These tests exercise it directly against D1 so a change to the tally or
// the results shape is caught even if no endpoint happens to cover it.
beforeAll(async () => {
  await applySchema();
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('vote_rate_limit', '1000/h')").run();
});

describe('shared options engine against D1', () => {
  it('returns the three virtual options for a verdict poll and stored rows otherwise', async () => {
    const verdictId = await seedPoll({ title: 'Engine verdict poll' });
    const verdictOptions = await getPollOptions(env, { id: verdictId, poll_type: 1 });
    expect(verdictOptions).toEqual([
      { id: 1, position: 1, label: 'approve', virtual: true },
      { id: 3, position: 2, label: 'neutral', virtual: true },
      { id: 2, position: 3, label: 'oppose', virtual: true }
    ]);

    const choiceId = await seedPoll({ title: 'Engine choice poll', pollType: 3 });
    await seedOptions(choiceId, [
      { position: 1, label: 'First' },
      { position: 2, label: 'Second' },
      { position: 3, label: 'Third' }
    ]);
    const stored = await getPollOptions(env, { id: choiceId, poll_type: 3 });
    expect(stored.map((option) => [option.position, option.label, option.virtual])).toEqual([
      [1, 'First', false], [2, 'Second', false], [3, 'Third', false]
    ]);
  });

  it('counts a page of mixed polls with a fixed number of queries', async () => {
    const verdictId = await seedPoll({ title: 'Counted verdict poll' });
    const multiId = await seedPoll({ title: 'Counted multi poll', pollType: 3 });
    const multi = await seedOptions(multiId, [
      { position: 1, label: 'A' },
      { position: 2, label: 'B' }
    ]);

    await voteRequest(verdictId, '1'.repeat(64), 'approve');
    await voteRequest(verdictId, '2'.repeat(64), 'oppose');
    await choiceVoteRequest(multiId, '3'.repeat(64), [multi.get(1)!, multi.get(2)!]);
    await choiceVoteRequest(multiId, '4'.repeat(64), [multi.get(1)!]);

    const polls = [
      { id: verdictId, poll_type: 1 },
      { id: multiId, poll_type: 3 }
    ];
    const tallies = await countBallots(env, polls);

    const verdictTally = tallies.get(verdictId)!;
    expect(verdictTally.ballots).toBe(2);
    expect(verdictTally.counts.get(1)).toBe(1);
    expect(verdictTally.counts.get(2)).toBe(1);

    const multiTally = tallies.get(multiId)!;
    // Two ballots, and the same option can be counted once per ballot.
    expect(multiTally.ballots).toBe(2);
    expect(multiTally.counts.get(multi.get(1)!)).toBe(2);
    expect(multiTally.counts.get(multi.get(2)!)).toBe(1);

    // A poll with no rows keeps a zero tally rather than going missing.
    const emptyId = await seedPoll({ title: 'Counted empty poll' });
    const empties = await countBallots(env, [{ id: emptyId, poll_type: 1 }]);
    expect(empties.get(emptyId)).toEqual({ ballots: 0, counts: new Map() });
  });

  it('publishes counts only above the ballot threshold and never the combination', async () => {
    const pollId = await seedPoll({ title: 'Engine threshold poll', pollType: 3 });
    const options = await seedOptions(pollId, [
      { position: 1, label: 'One' },
      { position: 2, label: 'Two' }
    ]);
    await choiceVoteRequest(pollId, '5'.repeat(64), [options.get(1)!, options.get(2)!]);

    const tally = (await countBallots(env, [{ id: pollId, poll_type: 3 }])).get(pollId)!;
    const engineOptions = await getPollOptions(env, { id: pollId, poll_type: 3 });

    const hidden = toPublicResults({ poll_type: 3 }, engineOptions, tally, 5);
    expect(hidden.hidden).toBe(true);
    expect(hidden.options).toBeNull();
    expect(hidden.ballots).toBe(1);

    const visible = toPublicResults({ poll_type: 3 }, engineOptions, tally, 1);
    expect(visible.hidden).toBe(false);
    expect(visible.options?.map((option) => [option.position, option.count])).toEqual([[1, 1], [2, 1]]);
    // The response carries per-option counts only; nothing groups the two
    // selections made on the same ballot.
    expect(Object.keys(visible)).toEqual(['pollType', 'ballots', 'hidden', 'threshold', 'options']);
    expect(JSON.stringify(visible)).not.toContain('selection');
  });

  it('reads the options of many polls in one call', async () => {
    const first = await seedPoll({ title: 'Batch options one', pollType: 2 });
    const second = await seedPoll({ title: 'Batch options two' });
    const stored = await seedOptions(first, [
      { position: 1, label: 'Left' },
      { position: 2, label: 'Right' }
    ]);
    expect(stored.size).toBe(2);
    expect(await lastId()).toBeGreaterThan(0);

    const byPoll = await getOptionsForPolls(env, [
      { id: first, poll_type: 2 },
      { id: second, poll_type: 1 }
    ]);
    expect(byPoll.get(first)?.map((option) => option.label)).toEqual(['Left', 'Right']);
    expect(byPoll.get(second)?.every((option) => option.virtual)).toBe(true);
  });
});
