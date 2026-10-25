// "My comments" endpoints.
//
// A comment stores one fixed `author_mark` per account, so the dashboard lists and
// deletes the comments an account posted via a plain paginated query while readers
// still see an anonymous comment.

import { beforeAll, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { ORIGIN, applySchema, seedPoll } from './helpers';

beforeAll(async () => {
  await applySchema();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('register_rate_limit', '1000/d')"),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('comment_rate_limit', '1000/h')"),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('user_comment_delay_minutes', '0')"),
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

function listComments(cookie: string, page = 1): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/user/comments?page=${page}`, { headers: { cookie } });
}

function deleteComment(id: string, cookie: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/user/comments/${id}`, {
    method: 'DELETE',
    headers: { origin: ORIGIN, cookie }
  });
}

describe('my comments', () => {
  it('stores an author mark on a posted comment without publishing it', async () => {
    const pollId = await seedPoll({ title: 'Author mark poll' });
    const cookie = await register('author-mark-user');
    const id = await postComment(pollId, cookie);

    // The row carries a mark the public API never returns.
    const row = await env.DB.prepare('SELECT author_mark FROM comments WHERE public_id = ?')
      .bind(id).first<{ author_mark: string | null }>();
    expect(row?.author_mark).toMatch(/^[0-9a-f]{64}$/);

    const listing = await (await SELF.fetch(`${ORIGIN}/api/comments/${pollId}`)).json() as any;
    expect(listing.comments).toHaveLength(1);
    expect(listing.comments[0]).toEqual({
      id,
      comment: 'A comment on this public poll.',
      createdAt: expect.any(String)
    });
    expect(JSON.stringify(listing)).not.toContain('author');
  });

  it('lists the comments the account posted', async () => {
    const pollId = await seedPoll({ title: 'My comments poll' });
    const cookie = await register('my-comments-user');
    const first = await postComment(pollId, cookie, 'The first remark.');
    const second = await postComment(pollId, cookie, 'The second remark.');

    const body = await (await listComments(cookie)).json() as any;
    // Both comments come back with the poll they belong to. They share one
    // hour-coarsened timestamp, so the order is the server's business.
    expect(body.comments).toHaveLength(2);
    expect(body.comments.map((comment: any) => comment.comment).sort()).toEqual([
      'The first remark.', 'The second remark.'
    ]);
    expect(body.comments[0]).toMatchObject({ pollId, pollTitle: 'My comments poll' });
    expect(body.page).toBe(1);
    expect(body.hasMore).toBe(false);
    expect([first, second]).toContain(body.comments[0].id);
  });

  it('does not list another account\u2019s comment', async () => {
    const pollId = await seedPoll({ title: 'Foreign comment poll' });
    const mine = await register('comment-owner');
    const theirs = await register('comment-other');
    const myId = await postComment(pollId, mine);
    await postComment(pollId, theirs);

    const body = await (await listComments(mine)).json() as any;
    expect(body.comments.map((comment: any) => comment.id)).toEqual([myId]);
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
    const body = await (await listComments(mine)).json() as any;
    expect(body.comments).toEqual([]);
  });

  it('requires a signed-in account', async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/user/comments?page=1`);
    expect(response.status).toBe(401);
  });

  it('limits the dashboard list per account', async () => {
    const pollId = await seedPoll({ title: 'List quota poll' });
    const cookie = await register('list-quota-user');
    await postComment(pollId, cookie);

    // The quota is 60 requests per hour, shared by both list endpoints.
    for (let attempt = 0; attempt < 60; attempt += 1) {
      expect((await listComments(cookie)).status).toBe(200);
    }

    // The next request is refused, so a stolen session cannot query indefinitely.
    const limited = await listComments(cookie);
    expect(limited.status).toBe(429);
    expect((await limited.json() as any).error.code).toBe('RATE_LIMIT_EXCEEDED');
  });
});
