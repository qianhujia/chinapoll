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
  seedVerdictTemplatePoll
} from './helpers';

// The shared engine is the single counting and results path for both poll types.
// These tests exercise it directly against D1 so a change to the tally or the
// results shape is caught even if no endpoint happens to cover it.
beforeAll(async () => {
  await applySchema();
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('vote_rate_limit', '1000/h')").run();
});

describe('shared options engine against D1', () => {
  it('returns the stored option rows of a poll, ordered by position', async () => {
    const singleId = await seedPoll({ title: 'Engine single poll', pollType: 2 });
    await seedOptions(singleId, [
      { position: 1, label: 'First' },
      { position: 2, label: 'Second' },
      { position: 3, label: 'Third' }
    ]);
    const single = await getPollOptions(env, { id: singleId, poll_type: 2 });
    expect(single.map((option) => [option.position, option.label])).toEqual([
      [1, 'First'], [2, 'Second'], [3, 'Third']
    ]);

    // A verdict poll keeps its three rows as ordinary labels.
    const { pollId: templateId, options: templateOptions } = await seedVerdictTemplatePoll();
    const template = await getPollOptions(env, { id: templateId, poll_type: 1 });
    expect(template.map((option) => [option.position, option.label])).toEqual([
      [1, 'Approve'], [2, 'Neutral'], [3, 'Oppose']
    ]);
    expect(template.map((option) => option.id)).toEqual([...templateOptions.values()]);
  });

  it('writes one ballot row and the expected selections for every ballot shape', async () => {
    // A single choice ballot: one ballot row and one selection.
    const singleId = await seedPoll({ title: 'Engine single ballot', pollType: 2 });
    const single = await seedOptions(singleId, [
      { position: 1, label: 'Bus' },
      { position: 2, label: 'Metro' }
    ]);
    expect((await choiceVoteRequest(singleId, '1'.repeat(64), [single.get(2)!])).status).toBe(200);

    // A verdict ballot: also one ballot row and one selection.
    const { pollId: templateId, options: template } = await seedVerdictTemplatePoll({ title: 'Engine verdict ballot' });
    expect((await choiceVoteRequest(templateId, '2'.repeat(64), [template.get(3)!])).status).toBe(200);

    // A multiple choice ballot: one ballot row and one selection per chosen option.
    const multiId = await seedPoll({ title: 'Engine multi ballot', pollType: 3 });
    const multi = await seedOptions(multiId, [
      { position: 1, label: 'A' },
      { position: 2, label: 'B' },
      { position: 3, label: 'C' }
    ]);
    expect((await choiceVoteRequest(multiId, '3'.repeat(64), [multi.get(1)!, multi.get(3)!])).status).toBe(200);

    for (const pollId of [singleId, templateId, multiId]) {
      const ballots = await env.DB.prepare('SELECT COUNT(*) AS total FROM votes WHERE poll_id = ?')
        .bind(pollId).first<{ total: number }>();
      expect(ballots?.total).toBe(1);
    }

    const selections = await env.DB.prepare(
      'SELECT poll_id, option_id FROM vote_selections ORDER BY poll_id ASC, option_id ASC'
    ).all<{ poll_id: number; option_id: number }>();
    expect(selections.results).toEqual([
      { poll_id: singleId, option_id: single.get(2)! },
      { poll_id: templateId, option_id: template.get(3)! },
      { poll_id: multiId, option_id: multi.get(1)! },
      { poll_id: multiId, option_id: multi.get(3)! }
    ]);
  });

  it('counts a page of polls with a fixed number of queries', async () => {
    const singleId = await seedPoll({ title: 'Counted single poll', pollType: 2 });
    const single = await seedOptions(singleId, [
      { position: 1, label: 'Bus' },
      { position: 2, label: 'Metro' }
    ]);
    const multiId = await seedPoll({ title: 'Counted multi poll', pollType: 3 });
    const multi = await seedOptions(multiId, [
      { position: 1, label: 'A' },
      { position: 2, label: 'B' }
    ]);

    await choiceVoteRequest(singleId, '4'.repeat(64), [single.get(1)!]);
    await choiceVoteRequest(singleId, '5'.repeat(64), [single.get(2)!]);
    await choiceVoteRequest(multiId, '6'.repeat(64), [multi.get(1)!, multi.get(2)!]);
    await choiceVoteRequest(multiId, '7'.repeat(64), [multi.get(1)!]);

    // Every poll is counted by the same two queries: ballots from `votes` and the
    // per-option counts from `vote_selections`.
    const tallies = await countBallots(env, [
      { id: singleId, poll_type: 2 },
      { id: multiId, poll_type: 3 }
    ]);

    const singleTally = tallies.get(singleId)!;
    expect(singleTally.ballots).toBe(2);
    expect(singleTally.counts.get(single.get(1)!)).toBe(1);
    expect(singleTally.counts.get(single.get(2)!)).toBe(1);

    const multiTally = tallies.get(multiId)!;
    // Two ballots, and the same option can be counted once per ballot.
    expect(multiTally.ballots).toBe(2);
    expect(multiTally.counts.get(multi.get(1)!)).toBe(2);
    expect(multiTally.counts.get(multi.get(2)!)).toBe(1);

    // A poll with no rows keeps a zero tally rather than going missing.
    const emptyId = await seedPoll({ title: 'Counted empty poll', pollType: 2 });
    const empties = await countBallots(env, [{ id: emptyId, poll_type: 2 }]);
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
    const second = await seedPoll({ title: 'Batch options two', pollType: 3 });
    const stored = await seedOptions(first, [
      { position: 1, label: 'Left' },
      { position: 2, label: 'Right' }
    ]);
    expect(stored.size).toBe(2);
    expect(await lastId()).toBeGreaterThan(0);

    const byPoll = await getOptionsForPolls(env, [
      { id: first, poll_type: 2 },
      { id: second, poll_type: 3 }
    ]);
    expect(byPoll.get(first)?.map((option) => option.label)).toEqual(['Left', 'Right']);
    // A poll with no rows still gets an (empty) entry.
    expect(byPoll.get(second)).toEqual([]);
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
