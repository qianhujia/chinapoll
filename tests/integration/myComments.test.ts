// "My comments" endpoints.
//
// A comment keeps a one-way owner hash (see worker/services/owner.ts), so the
// dashboard can list and delete the comments an account posted while readers still
// see an anonymous comment. The client supplies the public ids it remembered from
// posting, and the server answers only for rows whose owner hash matches.

import { beforeAll, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { ORIGIN, applySchema, seedPoll } from './helpers';

beforeAll(async () => {
  await applySchema();
  // The file registers several accounts and posts several comments; the gates
  // themselves are covered by accounts.test.ts.
  await env.DB.batch([
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('register_rate_limit', '1000/d')"),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('comment_rate_limit', '1000/h')"),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('user_comment_delay_hours', '0')"),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('max_accounts_per_ip', '50')")
  ]);
});

async function register(username: string): Promise<string> {
  const response = await SELF.fetch(`${ORIGIN}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ username, password: 'test-password-123' })
  });
  expect(response.status).toBe(201);
  // Backdate the account so the comment delay never applies.
  await env.DB.prepare('UPDATE users SET created_at = created_at - 25 * 3600 WHERE username = ?')
    .bind(username).run();
  return (response.headers.get('set-cookie') ?? '').split(';')[0];
}

async function postComment(pollId: number, cookie: string, comment = 'A comment on this public poll.'): Promise<string> {
  const response = await SELF.fetch(`${ORIGIN}/api/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
    body: JSON.stringify({ pollId, comment })
  });
  expect(response.status).toBe(201);
  return (await response.json() as { id: string }).id;
}

function listComments(ids: string[], cookie: string): Promise<Response> {
  const params = new URLSearchParams({ ids: ids.join(',') });
  return SELF.fetch(`${ORIGIN}/api/user/comments?${params}`, { headers: { cookie } });
}

function deleteComment(id: string, cookie: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/user/comments/${id}`, {
    method: 'DELETE',
    headers: { origin: ORIGIN, cookie }
  });
}

describe('my comments', () => {
  it('stores an owner hash on a posted comment without publishing it', async () => {
    const pollId = await seedPoll({ title: 'Owner hash poll' });
    const cookie = await register('owner-hash-user');
    const id = await postComment(pollId, cookie);

    // The row carries a hash the public API never returns.
    const row = await env.DB.prepare('SELECT owner_hash FROM comments WHERE public_id = ?')
      .bind(id).first<{ owner_hash: string | null }>();
    expect(row?.owner_hash).toMatch(/^[0-9a-f]{64}$/);

    const listing = await (await SELF.fetch(`${ORIGIN}/api/comments/${pollId}`)).json() as any;
    expect(listing.comments).toHaveLength(1);
    expect(listing.comments[0]).toEqual({
      id,
      comment: 'A comment on this public poll.',
      createdAt: expect.any(String)
    });
    expect(JSON.stringify(listing)).not.toContain('owner');
  });

  it('lists the comments the account posted', async () => {
    const pollId = await seedPoll({ title: 'My comments poll' });
    const cookie = await register('my-comments-user');
    const first = await postComment(pollId, cookie, 'The first remark.');
    const second = await postComment(pollId, cookie, 'The second remark.');

    const body = await (await listComments([first, second], cookie)).json() as any;
    // Both comments come back with the poll they belong to. Their relative order is
    // the client's business: the hour-coarsened timestamp cannot order them.
    expect(body.comments).toHaveLength(2);
    expect(body.comments.map((comment: any) => comment.comment).sort()).toEqual([
      'The first remark.', 'The second remark.'
    ]);
    expect(body.comments[0]).toMatchObject({ pollId, pollTitle: 'My comments poll' });
  });

  it('ignores ids the account does not own and rejects a malformed list', async () => {
    const pollId = await seedPoll({ title: 'Foreign comment poll' });
    const mine = await register('comment-owner');
    const theirs = await register('comment-other');
    const myId = await postComment(pollId, mine);
    const theirId = await postComment(pollId, theirs);

    // The other account's comment is not returned for my id list.
    const body = await (await listComments([myId, theirId], mine)).json() as any;
    expect(body.comments.map((comment: any) => comment.id)).toEqual([myId]);

    // A row created before the owner hash existed is never claimed.
    await env.DB.prepare('UPDATE comments SET owner_hash = NULL WHERE public_id = ?').bind(myId).run();
    const unclaimed = await (await listComments([myId], mine)).json() as any;
    expect(unclaimed.comments).toEqual([]);

    expect((await listComments(['not-an-id'], mine)).status).toBe(400);
    expect(await (await listComments([], mine)).json()).toEqual({ comments: [] });
  });

  it('deletes only the account\u2019s own comment', async () => {
    const pollId = await seedPoll({ title: 'Comment delete poll' });
    const mine = await register('comment-deleter');
    const theirs = await register('comment-keep');
    const myId = await postComment(pollId, mine);
    const theirId = await postComment(pollId, theirs);

    const refused = await deleteComment(theirId, mine);
    expect(refused.status).toBe(404);

    const deleted = await deleteComment(myId, mine);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ ok: true, id: myId, deleted: true });

    const remaining = await env.DB.prepare('SELECT public_id FROM comments WHERE poll_id = ?')
      .bind(pollId).all<{ public_id: string }>();
    expect(remaining.results).toEqual([{ public_id: theirId }]);
    // The owner's list is empty again.
    const body = await (await listComments([myId], mine)).json() as any;
    expect(body.comments).toEqual([]);
  });

  it('requires a signed-in account', async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/user/comments?ids=0123456789abcdef`);
    expect(response.status).toBe(401);
  });
});
