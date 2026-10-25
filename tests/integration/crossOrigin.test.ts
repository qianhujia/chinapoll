// Same-origin enforcement on the anonymous mutation endpoints.
//
// Voting, reporting, and view counting take no account, so before the Origin check
// a third-party page could POST to any of them from every visitor's browser: each
// visitor becomes one ballot, report, or view from a distinct network bucket, which
// walks around the per-network rate limit. Turnstile closes the same hole through
// its hostname check, but it is optional and off by default. These tests pin the
// refusal and prove the ordinary same-origin call still works.

import { beforeAll, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { ORIGIN, applySchema, seedComment, seedOptions, seedPoll } from './helpers';

const EVIL_ORIGIN = 'https://evil.example';

beforeAll(async () => {
  await applySchema();
});

// A POST as a browser would send it, from `origin` and with an optional JSON body.
// A null origin stands for a caller that is not a browser page.
function post(path: string, origin: string | null, body?: unknown): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      ...(origin ? { origin } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

describe('anonymous mutations require the site origin', () => {
  it('refuses a vote from another origin and writes nothing', async () => {
    const pollId = await seedPoll({ title: 'Cross-origin vote poll' });
    const options = await seedOptions(pollId, [
      { position: 1, label: 'First option' },
      { position: 2, label: 'Second option' }
    ]);
    const ballot = { pollId, tokenHash: 'a'.repeat(64), optionIds: [options.get(1)!] };

    const crossOrigin = await post('/api/vote', EVIL_ORIGIN, ballot);
    expect(crossOrigin.status).toBe(403);
    expect(await crossOrigin.json()).toMatchObject({
      error: { code: 'CROSS_ORIGIN_REJECTED' },
      message: 'cross-origin request rejected'
    });

    // An origin-less caller, such as a hand-written script, is refused too.
    expect((await post('/api/vote', null, ballot)).status).toBe(403);

    // Neither refused attempt reached the database.
    const stored = await env.DB.prepare('SELECT COUNT(*) AS total FROM votes WHERE poll_id = ?')
      .bind(pollId).first<{ total: number }>();
    expect(Number(stored?.total ?? 0)).toBe(0);

    // The same ballot from the site's own origin is still accepted (a vote answers
    // 200, not 201).
    const accepted = await post('/api/vote', ORIGIN, ballot);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ ok: true, message: 'vote accepted' });
  });

  it('refuses a poll report from another origin', async () => {
    const pollId = await seedPoll({ title: 'Cross-origin report poll' });

    expect((await post(`/api/polls/${pollId}/report`, EVIL_ORIGIN, { reason: 'spam' })).status).toBe(403);
    expect((await post(`/api/polls/${pollId}/report`, null, { reason: 'spam' })).status).toBe(403);
    expect((await post(`/api/polls/${pollId}/report`, ORIGIN, { reason: 'spam' })).status).toBe(201);
  });

  it('refuses a comment report from another origin', async () => {
    const pollId = await seedPoll({ title: 'Cross-origin comment report poll' });
    await seedComment(pollId, 'aaaabbbbccccdddd');

    expect((await post('/api/comments/aaaabbbbccccdddd/report', EVIL_ORIGIN, { reason: 'spam' })).status)
      .toBe(403);
    expect((await post('/api/comments/aaaabbbbccccdddd/report', ORIGIN, { reason: 'spam' })).status)
      .toBe(201);
  });

  it('refuses a view from another origin', async () => {
    const pollId = await seedPoll({ title: 'Cross-origin view poll' });

    expect((await post(`/api/polls/${pollId}/view`, EVIL_ORIGIN)).status).toBe(403);
    expect((await post(`/api/polls/${pollId}/view`, null)).status).toBe(403);
    expect((await post(`/api/polls/${pollId}/view`, ORIGIN)).status).toBe(204);
  });
});