import { beforeAll, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { getPollOptions } from '../../worker/services/options';
import {
  ORIGIN,
  applySchema,
  choiceVoteRequest,
  insertBallot,
  seedOptions,
  seedPoll,
  voteRequest as vote,
  voteStatusRequest
} from './helpers';

beforeAll(async () => {
  await applySchema();
  // The functional tests below cast more than the default 5/h vote limit; the
  // rate-limit behaviour itself is covered in rateLimit.test.ts.
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('vote_rate_limit', '1000/h')").run();
});

function countsFor(listing: any, pollId: number) {
  return listing.polls.find((entry: any) => entry.poll.id === pollId)?.stats;
}

describe('vote endpoint', () => {
  it('refuses a vote on a closed poll', async () => {
    const id = await seedPoll({ title: 'Closed poll', status: 2, closedAt: 1 });

    const response = await vote(id, 'a'.repeat(64));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, message: 'poll is not open' });
  });

  it('rejects a duplicate vote but accepts a second device token', async () => {
    const id = await seedPoll({ title: 'Duplicate poll' });

    expect((await vote(id, 'a'.repeat(64))).status).toBe(200);
    const duplicate = await vote(id, 'a'.repeat(64));
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ ok: false, message: 'duplicate vote' });

    expect((await vote(id, 'b'.repeat(64), 'oppose')).status).toBe(200);
    // Each ballot is one row and carries exactly one selection on its preset row.
    const ballots = await env.DB.prepare('SELECT COUNT(*) AS total FROM votes WHERE poll_id = ?')
      .bind(id).first<{ total: number }>();
    expect(ballots?.total).toBe(2);
    const selections = await env.DB.prepare(
      `SELECT o.preset_key, COUNT(*) AS count
       FROM vote_selections vs JOIN poll_options o ON o.id = vs.option_id
       WHERE vs.poll_id = ? GROUP BY o.preset_key ORDER BY o.preset_key ASC`
    ).bind(id).all();
    expect(selections.results).toEqual([
      { preset_key: 'approve', count: 1 },
      { preset_key: 'oppose', count: 1 }
    ]);
  });

  it('hides counts below the display threshold and reveals them at it', async () => {
    const id = await seedPoll({ title: 'Threshold poll' });
    const presets = await getPollOptions(env, { id, poll_type: 1 });
    const approveId = presets.find((option) => option.presetKey === 'approve')!.id;
    await vote(id, 'c'.repeat(64));

    let listing = await (await SELF.fetch(`${ORIGIN}/api/polls?pageSize=100`)).json() as any;
    expect(countsFor(listing, id).hidden).toBe(true);
    expect(countsFor(listing, id).counts).toBeNull();

    // The default display threshold is 10, so nine more ballots reveal the counts.
    for (let index = 0; index < 9; index += 1) {
      await insertBallot(id, String(index).padStart(64, 'd'), [approveId]);
    }

    listing = await (await SELF.fetch(`${ORIGIN}/api/polls?pageSize=100`)).json() as any;
    expect(countsFor(listing, id).hidden).toBe(false);
    expect(countsFor(listing, id).counts.approve).toBe(10);
  });

  it('accepts a vote below the display threshold and withholds only the counts', async () => {
    const id = await seedPoll({ title: 'Votable below threshold poll' });

    const response = await vote(id, 'e'.repeat(64));
    expect(response.status).toBe(200);

    const body = await response.json() as any;
    // The threshold hides results only: the ballot is accepted and the voter is
    // told the vote was recorded, while every count stays withheld.
    expect(body.ok).toBe(true);
    expect(body.voted).toBe(true);
    expect(body.hidden).toBe(true);
    expect(body.counts).toBeNull();
    expect(body.options).toBeNull();
    expect(body.ballots).toBe(1);
    expect(body.threshold).toBe(10);

    // The ballot really is stored, and so is its selection.
    const stored = await env.DB.prepare('SELECT COUNT(*) AS total FROM votes WHERE poll_id = ?')
      .bind(id).first<{ total: number }>();
    expect(stored?.total).toBe(1);
    const selections = await env.DB.prepare('SELECT COUNT(*) AS total FROM vote_selections WHERE poll_id = ?')
      .bind(id).first<{ total: number }>();
    expect(selections?.total).toBe(1);
  });

  it('restores the stored selection through vote/status', async () => {
    const id = await seedPoll({ title: 'Restored selection poll' });
    const presets = await getPollOptions(env, { id, poll_type: 1 });
    const neutralId = presets.find((option) => option.presetKey === 'neutral')!.id;

    expect((await vote(id, 'f'.repeat(64), 'neutral')).status).toBe(200);
    const status = await (await voteStatusRequest(id, 'f'.repeat(64))).json() as any;
    expect(status.voted).toBe(true);
    // The legacy verdict field and the option ids agree.
    expect(status.option).toBe('neutral');
    expect(status.optionIds).toEqual([neutralId]);

    const noVote = await (await voteStatusRequest(id, '0'.repeat(64))).json() as any;
    expect(noVote.voted).toBe(false);
    expect(noVote.option).toBeNull();
    expect(noVote.optionIds).toEqual([]);
  });

  it('refuses an option id that belongs to another poll', async () => {
    const first = await seedPoll({ title: 'Foreign option poll', pollType: 3 });
    const second = await seedPoll({ title: 'Foreign option source', pollType: 3 });
    const firstOptions = await seedOptions(first, [
      { position: 1, label: 'Mine' },
      { position: 2, label: 'Also mine' }
    ]);
    const secondOptions = await seedOptions(second, [
      { position: 1, label: 'Theirs' },
      { position: 2, label: 'Also theirs' }
    ]);

    const foreign = await choiceVoteRequest(first, 'a1'.repeat(32), [secondOptions.get(1)!]);
    expect(foreign.status).toBe(400);
    expect(await foreign.json()).toMatchObject({ ok: false, message: 'unknown option' });

    // A valid ballot on the same poll is still accepted.
    expect((await choiceVoteRequest(first, 'a1'.repeat(32), [firstOptions.get(1)!])).status).toBe(200);
  });

  it('accepts a verdict on a poll without a neutral row and refuses an unknown verdict', async () => {
    const id = await seedPoll({ title: 'No neutral poll', presets: ['approve', 'oppose'] });
    const presets = await getPollOptions(env, { id, poll_type: 1 });
    expect(presets.map((option) => option.presetKey)).toEqual(['approve', 'oppose']);

    expect((await vote(id, 'b1'.repeat(32), 'oppose')).status).toBe(200);
    const status = await (await voteStatusRequest(id, 'b1'.repeat(32))).json() as any;
    expect(status.option).toBe('oppose');

    // The missing neutral row cannot be selected.
    expect((await vote(id, 'b2'.repeat(32), 'neutral')).status).toBe(400);
    expect((await vote(id, 'b3'.repeat(32), 'nonsense')).status).toBe(400);
  });

  it('carries the Content Security Policy on a deep link', async () => {
    const response = await SELF.fetch(`${ORIGIN}/poll/1`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
  });
});
