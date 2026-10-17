import { beforeAll, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { ORIGIN, applySchema, seedPoll, voteRequest as vote } from './helpers';

beforeAll(async () => {
  await applySchema();
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
    const counts = await env.DB.prepare(
      'SELECT option, COUNT(*) AS count FROM votes WHERE poll_id = ? GROUP BY option'
    ).bind(id).all();
    expect(counts.results).toHaveLength(2);
  });

  it('hides counts below the display threshold and reveals them at it', async () => {
    const id = await seedPoll({ title: 'Threshold poll' });
    await vote(id, 'c'.repeat(64));

    let listing = await (await SELF.fetch(`${ORIGIN}/api/polls?pageSize=100`)).json() as any;
    expect(countsFor(listing, id).hidden).toBe(true);
    expect(countsFor(listing, id).counts).toBeNull();

    // The default display threshold is 10, so nine more votes reveal the counts.
    const statements = [];
    for (let index = 0; index < 9; index += 1) {
      statements.push(
        env.DB.prepare('INSERT INTO votes (poll_id, voter_token_hash, option, created_at) VALUES (?, ?, 1, unixepoch())')
          .bind(id, String(index).padStart(64, 'd'))
      );
    }
    await env.DB.batch(statements);

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

    // The ballot really is stored.
    const stored = await env.DB.prepare('SELECT COUNT(*) AS total FROM votes WHERE poll_id = ?')
      .bind(id).first<{ total: number }>();
    expect(stored?.total).toBe(1);
  });

  it('carries the Content Security Policy on a deep link', async () => {
    const response = await SELF.fetch(`${ORIGIN}/poll/1`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
  });
});


