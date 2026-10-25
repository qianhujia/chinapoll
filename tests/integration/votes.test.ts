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
  voteStatusRequest
} from './helpers';
import { handleVoteRequest } from '../../worker/api/vote';
import type { HandlerEnv } from '../../worker/index';

beforeAll(async () => {
  await applySchema();
  // The functional tests below cast more than the default 5/h vote limit; the
  // rate-limit behaviour itself is covered in rateLimit.test.ts.
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('vote_rate_limit', '1000/h')").run();
});

function statsFor(listing: any, pollId: number) {
  return listing.polls.find((entry: any) => entry.poll.id === pollId)?.stats;
}

describe('vote endpoint', () => {
  it('refuses a vote on a closed poll', async () => {
    const id = await seedPoll({ title: 'Closed poll', status: 2, closedAt: 1 });
    const options = await seedOptions(id, [
      { position: 1, label: 'Yes' },
      { position: 2, label: 'No' }
    ]);

    const response = await choiceVoteRequest(id, 'a'.repeat(64), [options.get(1)!]);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, message: 'poll is not open' });
  });

  it('rejects a duplicate vote but accepts a second device token', async () => {
    const id = await seedPoll({ title: 'Duplicate poll' });
    const options = await seedOptions(id, [
      { position: 1, label: 'Yes' },
      { position: 2, label: 'No' }
    ]);

    expect((await choiceVoteRequest(id, 'a'.repeat(64), [options.get(1)!])).status).toBe(200);
    const duplicate = await choiceVoteRequest(id, 'a'.repeat(64), [options.get(1)!]);
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ ok: false, message: 'duplicate vote' });

    expect((await choiceVoteRequest(id, 'b'.repeat(64), [options.get(2)!])).status).toBe(200);
    // Each ballot is one row and carries exactly one selection.
    const ballots = await env.DB.prepare('SELECT COUNT(*) AS total FROM votes WHERE poll_id = ?')
      .bind(id).first<{ total: number }>();
    expect(ballots?.total).toBe(2);
    const selections = await env.DB.prepare(
      `SELECT o.label, COUNT(*) AS count
       FROM vote_selections vs JOIN poll_options o ON o.id = vs.option_id
       WHERE vs.poll_id = ? GROUP BY o.label ORDER BY o.label ASC`
    ).bind(id).all();
    expect(selections.results).toEqual([
      { label: 'No', count: 1 },
      { label: 'Yes', count: 1 }
    ]);
  });

  // The ballot body is `{ optionIds }` only: the verdict-era `option` label was
  // removed together with the verdict poll type.
  it('refuses the removed legacy option label', async () => {
    const id = await seedPoll({ title: 'Legacy option poll' });
    await seedOptions(id, [
      { position: 1, label: 'Approve' },
      { position: 2, label: 'Neutral' },
      { position: 3, label: 'Oppose' }
    ]);

    const response = await legacyOptionVoteRequest(id, 'c'.repeat(64), 'approve');
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, message: 'bad request' });

    // Nothing was stored.
    const ballots = await env.DB.prepare('SELECT COUNT(*) AS total FROM votes WHERE poll_id = ?')
      .bind(id).first<{ total: number }>();
    expect(ballots?.total).toBe(0);
  });

  it('hides counts below the display threshold and reveals them at it', async () => {
    const id = await seedPoll({ title: 'Threshold poll' });
    const options = await seedOptions(id, [
      { position: 1, label: 'Yes' },
      { position: 2, label: 'No' }
    ]);
    await choiceVoteRequest(id, 'd'.repeat(64), [options.get(1)!]);

    let listing = await (await SELF.fetch(`${ORIGIN}/api/polls?pageSize=100`)).json() as any;
    expect(statsFor(listing, id).hidden).toBe(true);
    expect(statsFor(listing, id).options).toBeNull();

    // The default display threshold is 10, so nine more ballots reveal the counts.
    for (let index = 0; index < 9; index += 1) {
      await insertBallot(id, String(index).padStart(64, 'e'), [options.get(1)!]);
    }

    listing = await (await SELF.fetch(`${ORIGIN}/api/polls?pageSize=100`)).json() as any;
    const stats = statsFor(listing, id);
    expect(stats.hidden).toBe(false);
    expect(stats.ballots).toBe(10);
    // The count lives on the option itself; there is no separate counts object.
    expect(stats.counts).toBeUndefined();
    expect(stats.options.map((option: any) => [option.label, option.count])).toEqual([
      ['Yes', 10], ['No', 0]
    ]);
  });

  it('accepts a vote below the display threshold and withholds only the counts', async () => {
    const id = await seedPoll({ title: 'Votable below threshold poll' });
    const options = await seedOptions(id, [
      { position: 1, label: 'Yes' },
      { position: 2, label: 'No' }
    ]);

    const response = await choiceVoteRequest(id, 'f'.repeat(64), [options.get(1)!]);
    expect(response.status).toBe(200);

    const body = await response.json() as any;
    // The threshold hides results only: the ballot is accepted and the voter is
    // told the vote was recorded, while every count stays withheld.
    expect(body.ok).toBe(true);
    expect(body.voted).toBe(true);
    expect(body.hidden).toBe(true);
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

  it('restores the stored selections through vote/status', async () => {
    const id = await seedPoll({ title: 'Restored selection poll', pollType: 3 });
    const options = await seedOptions(id, [
      { position: 1, label: 'One' },
      { position: 2, label: 'Two' },
      { position: 3, label: 'Three' }
    ]);

    expect((await choiceVoteRequest(id, '1a'.repeat(32), [options.get(1)!, options.get(3)!])).status).toBe(200);
    const status = await (await voteStatusRequest(id, '1a'.repeat(32))).json() as any;
    expect(status.voted).toBe(true);
    // The selections come back in display order, and there is no legacy field.
    expect(status.optionIds).toEqual([options.get(1)!, options.get(3)!]);
    expect(status.option).toBeUndefined();

    const noVote = await (await voteStatusRequest(id, '2a'.repeat(32))).json() as any;
    expect(noVote.voted).toBe(false);
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

    const foreign = await choiceVoteRequest(first, '3a'.repeat(32), [secondOptions.get(1)!]);
    expect(foreign.status).toBe(400);
    expect(await foreign.json()).toMatchObject({ ok: false, message: 'unknown option' });

    // A valid ballot on the same poll is still accepted.
    expect((await choiceVoteRequest(first, '3a'.repeat(32), [firstOptions.get(1)!])).status).toBe(200);
  });

  it('carries the Content Security Policy on a deep link', async () => {
    const response = await SELF.fetch(`${ORIGIN}/poll/1`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  // Read-only mode returns 423 Locked, kept distinct from the 503 a missing
  // server key returns. The handler is called directly so the read-only flag is
  // set without waiting for the Worker's settings cache.
  it('answers 423 in read-only mode, distinct from the missing-key 503', async () => {
    const request = new Request(`${ORIGIN}/api/vote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ pollId: 1, tokenHash: 'a'.repeat(64), optionIds: [1] })
    });
    const response = await handleVoteRequest(
      request,
      { ...env, read_only_mode: true } as unknown as HandlerEnv
    );
    expect(response.status).toBe(423);
  });

  // `null` is valid JSON, so parsing alone is not enough: the body shape is checked
  // and a non-object answers 400 instead of throwing on a property read.
  it('answers 400 for a JSON body that is not an object', async () => {
    for (const path of ['/api/vote', '/api/vote/status']) {
      const response = await SELF.fetch(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: 'null'
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'INVALID_JSON' } });
    }
  });
});
