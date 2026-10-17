import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  countBallots,
  getOptionsForPolls,
  getPollOptions,
  toPublicResults
} from '../../worker/services/options';
import {
  applySchema,
  choiceVoteRequest,
  insertBallot,
  lastId,
  seedOptions,
  seedPoll,
  voteRequest
} from './helpers';

// The shared engine is the single counting and results path for all three poll
// types. These tests exercise it directly against D1 so a change to the tally or
// the results shape is caught even if no endpoint happens to cover it.
beforeAll(async () => {
  await applySchema();
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('vote_rate_limit', '1000/h')").run();
});

// The stored rows of a poll, reduced to the values a test cares about.
async function storedRows(pollId: number): Promise<Array<[number, string | null, string | null]>> {
  const rows = await getPollOptions(env, { id: pollId, poll_type: 1 });
  return rows.map((option) => [option.position, option.label, option.presetKey]);
}

describe('shared options engine against D1', () => {
  it('returns the preset rows of a verdict poll and the labels of a choice poll', async () => {
    const verdictId = await seedPoll({ title: 'Engine verdict poll' });
    expect(await storedRows(verdictId)).toEqual([
      [1, null, 'approve'],
      [2, null, 'oppose'],
      [3, null, 'neutral']
    ]);

    // The neutral row is optional: a poll created without it keeps two rows.
    const withoutNeutral = await seedPoll({
      title: 'Engine verdict poll without neutral',
      presets: ['approve', 'oppose']
    });
    expect(await storedRows(withoutNeutral)).toEqual([
      [1, null, 'approve'],
      [2, null, 'oppose']
    ]);

    const choiceId = await seedPoll({ title: 'Engine choice poll', pollType: 3 });
    await seedOptions(choiceId, [
      { position: 1, label: 'First' },
      { position: 2, label: 'Second' },
      { position: 3, label: 'Third' }
    ]);
    const stored = await getPollOptions(env, { id: choiceId, poll_type: 3 });
    expect(stored.map((option) => [option.position, option.label, option.presetKey])).toEqual([
      [1, 'First', null], [2, 'Second', null], [3, 'Third', null]
    ]);
  });

  it('writes one ballot row and the expected selections for every poll type', async () => {
    // A verdict ballot: one ballot row and one selection on the preset row.
    const verdictId = await seedPoll({ title: 'Engine verdict ballot' });
    const presets = await getPollOptions(env, { id: verdictId, poll_type: 1 });
    const opposeId = presets.find((option) => option.presetKey === 'oppose')!.id;
    expect((await voteRequest(verdictId, '1'.repeat(64), 'oppose')).status).toBe(200);

    // A single choice ballot: one ballot row and one selection.
    const singleId = await seedPoll({ title: 'Engine single ballot', pollType: 2 });
    const single = await seedOptions(singleId, [
      { position: 1, label: 'Bus' },
      { position: 2, label: 'Metro' }
    ]);
    expect((await choiceVoteRequest(singleId, '2'.repeat(64), [single.get(2)!])).status).toBe(200);

    // A multi choice ballot: one ballot row and one selection per chosen option.
    const multiId = await seedPoll({ title: 'Engine multi ballot', pollType: 3 });
    const multi = await seedOptions(multiId, [
      { position: 1, label: 'A' },
      { position: 2, label: 'B' },
      { position: 3, label: 'C' }
    ]);
    expect((await choiceVoteRequest(multiId, '3'.repeat(64), [multi.get(1)!, multi.get(3)!])).status).toBe(200);

    for (const pollId of [verdictId, singleId, multiId]) {
      const ballots = await env.DB.prepare('SELECT COUNT(*) AS total FROM votes WHERE poll_id = ?')
        .bind(pollId).first<{ total: number }>();
      expect(ballots?.total).toBe(1);
    }

    const selections = await env.DB.prepare(
      'SELECT poll_id, option_id FROM vote_selections ORDER BY poll_id ASC, option_id ASC'
    ).all<{ poll_id: number; option_id: number }>();
    expect(selections.results).toEqual([
      { poll_id: verdictId, option_id: opposeId },
      { poll_id: singleId, option_id: single.get(2)! },
      { poll_id: multiId, option_id: multi.get(1)! },
      { poll_id: multiId, option_id: multi.get(3)! }
    ]);
  });

  it('counts a page of mixed polls with a fixed number of queries', async () => {
    const verdictId = await seedPoll({ title: 'Counted verdict poll' });
    const presets = await getPollOptions(env, { id: verdictId, poll_type: 1 });
    const approveId = presets.find((option) => option.presetKey === 'approve')!.id;
    const opposeId = presets.find((option) => option.presetKey === 'oppose')!.id;

    const multiId = await seedPoll({ title: 'Counted multi poll', pollType: 3 });
    const multi = await seedOptions(multiId, [
      { position: 1, label: 'A' },
      { position: 2, label: 'B' }
    ]);

    await voteRequest(verdictId, '4'.repeat(64), 'approve');
    await voteRequest(verdictId, '5'.repeat(64), 'oppose');
    await choiceVoteRequest(multiId, '6'.repeat(64), [multi.get(1)!, multi.get(2)!]);
    await choiceVoteRequest(multiId, '7'.repeat(64), [multi.get(1)!]);

    // Every type is counted by the same two queries: ballots from `votes` and the
    // per-option counts from `vote_selections`.
    const tallies = await countBallots(env, [
      { id: verdictId, poll_type: 1 },
      { id: multiId, poll_type: 3 }
    ]);

    const verdictTally = tallies.get(verdictId)!;
    expect(verdictTally.ballots).toBe(2);
    expect(verdictTally.counts.get(approveId)).toBe(1);
    expect(verdictTally.counts.get(opposeId)).toBe(1);

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
    await choiceVoteRequest(pollId, '8'.repeat(64), [options.get(1)!, options.get(2)!]);

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
    expect(byPoll.get(second)?.map((option) => option.presetKey)).toEqual(['approve', 'oppose', 'neutral']);
  });

  // A ballot and its selections are written in two steps, so the stored rows must
  // stay consistent: one ballot, and one selection row per chosen option.
  it('stores the ballot and its selections consistently', async () => {
    const pollId = await seedPoll({ title: 'Consistent ballot poll', pollType: 2 });
    const options = await seedOptions(pollId, [
      { position: 1, label: 'Yes' },
      { position: 2, label: 'No' }
    ]);
    const voteId = await insertBallot(pollId, '9'.repeat(64), [options.get(1)!]);

    const stored = await env.DB.prepare(
      'SELECT poll_id, vote_id, option_id FROM vote_selections WHERE vote_id = ?'
    ).bind(voteId).all();
    expect(stored.results).toEqual([
      { poll_id: pollId, vote_id: voteId, option_id: options.get(1)! }
    ]);
  });
});
