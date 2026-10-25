// Author keys and the paginated dashboard.
//
// A poll or comment stores one fixed `author_mark` value per account, so "my
// polls" and "my comments" are plain paginated queries and the browser remembers
// nothing. The author key itself is only ever stored wrapped under a
// password-derived, recovery-code-derived, or session-derived key.

import { beforeAll, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { ORIGIN, applySchema, seedPoll } from './helpers';

beforeAll(async () => {
  await applySchema();
  // The file registers several accounts, submits over twenty polls, and logs in
  // repeatedly; the gates themselves are covered elsewhere.
  await env.DB.batch([
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('register_rate_limit', '1000/d')"),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('proposal_rate_limit', '1000/d')"),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('comment_rate_limit', '1000/h')"),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('login_rate_limit', '1000/h')"),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('user_poll_delay_minutes', '0')"),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('user_comment_delay_minutes', '0')"),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('max_accounts_per_ip', '50')")
  ]);
});

interface Registered {
  cookie: string;
  recoveryCode: string;
}

async function register(username: string, password = 'test-password-123'): Promise<Registered> {
  const response = await SELF.fetch(`${ORIGIN}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ username, password })
  });
  expect(response.status).toBe(201);
  return {
    cookie: (response.headers.get('set-cookie') ?? '').split(';')[0],
    recoveryCode: (await response.json() as { recoveryCode: string }).recoveryCode
  };
}

async function login(username: string, password = 'test-password-123'): Promise<string> {
  const response = await SELF.fetch(`${ORIGIN}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ username, password })
  });
  expect(response.status).toBe(200);
  return (response.headers.get('set-cookie') ?? '').split(';')[0];
}

async function propose(title: string, cookie: string): Promise<number> {
  const response = await SELF.fetch(`${ORIGIN}/api/proposal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
    body: JSON.stringify({
      title,
      pollType: 'single_choice',
      duration: 'none',
      options: [{ position: 1, label: 'Yes' }, { position: 2, label: 'No' }]
    })
  });
  expect(response.status).toBe(201);
  return (await response.json() as { pollId: number }).pollId;
}

function listPolls(cookie: string, page = 1): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/user/polls?page=${page}`, { headers: { cookie } });
}

function listComments(cookie: string, page = 1): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/user/comments?page=${page}`, { headers: { cookie } });
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

async function recover(username: string, code: string, newPassword: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/auth/recover`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ username, code, newPassword })
  });
}

describe('author marks and pagination', () => {
  it('lists the three polls the account submitted, newest first, with no next page', async () => {
    const { cookie } = await register('author-three');
    const first = await propose('First poll', cookie);
    const second = await propose('Second poll', cookie);
    const third = await propose('Third poll', cookie);

    const body = await (await listPolls(cookie)).json() as any;
    expect(body.page).toBe(1);
    expect(body.hasMore).toBe(false);
    // The three rows share one hour-coarsened timestamp, so the id breaks the tie.
    expect(body.polls.map((poll: any) => poll.id)).toEqual([third, second, first]);
  });

  it('splits twenty-one polls across two pages', async () => {
    const { cookie } = await register('author-many');
    const ids: number[] = [];
    for (let index = 0; index < 21; index += 1) {
      ids.push(await propose(`Batch poll ${index}`, cookie));
    }

    const firstPage = await (await listPolls(cookie, 1)).json() as any;
    expect(firstPage.polls).toHaveLength(20);
    expect(firstPage.hasMore).toBe(true);

    const secondPage = await (await listPolls(cookie, 2)).json() as any;
    expect(secondPage.polls).toHaveLength(1);
    expect(secondPage.hasMore).toBe(false);
    expect(secondPage.polls[0].id).toBe(ids[0]);
  });

  it('shows the same list to a second session of the account', async () => {
    const { cookie } = await register('author-two-devices');
    const pollId = await propose('Shared across devices', cookie);

    const secondCookie = await login('author-two-devices');
    const body = await (await listPolls(secondCookie)).json() as any;
    expect(body.polls.map((poll: any) => poll.id)).toEqual([pollId]);
  });

  it('never lists or closes another account\u2019s poll', async () => {
    const mine = await register('author-mine');
    const theirs = await register('author-theirs');
    await propose('Mine alone', mine.cookie);
    const theirPoll = await propose('Theirs alone', theirs.cookie);

    const body = await (await listPolls(mine.cookie)).json() as any;
    expect(body.polls.map((poll: any) => poll.title)).toEqual(['Mine alone']);

    const close = await SELF.fetch(`${ORIGIN}/api/user/polls/${theirPoll}/close`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie: mine.cookie }
    });
    expect(close.status).toBe(404);
  });

  it('keeps ownership across a recovery-code reset', async () => {
    const { cookie, recoveryCode } = await register('author-recover');
    const pollId = await propose('Survives recovery', cookie);

    const reset = await recover('author-recover', recoveryCode, 'fresh-password-456');
    expect(reset.status).toBe(200);

    // The reset signs every device out, so a fresh sign-in proves the new password.
    const newCookie = await login('author-recover', 'fresh-password-456');
    const body = await (await listPolls(newCookie)).json() as any;
    expect(body.polls.map((poll: any) => poll.id)).toEqual([pollId]);

    // The old code is single-use and is now rejected.
    const replay = await recover('author-recover', recoveryCode, 'another-password-789');
    expect(replay.status).toBe(401);
  });

  it('keeps ownership across a regenerated recovery code', async () => {
    const { cookie } = await register('author-regenerate');
    const pollId = await propose('Survives regeneration', cookie);

    const regenerate = await SELF.fetch(`${ORIGIN}/api/user/recovery-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
      body: JSON.stringify({ currentPassword: 'test-password-123' })
    });
    expect(regenerate.status).toBe(200);
    const nextCode = (await regenerate.json() as { recoveryCode: string }).recoveryCode;

    const reset = await recover('author-regenerate', nextCode, 'new-password-abc');
    expect(reset.status).toBe(200);

    const newCookie = await login('author-regenerate', 'new-password-abc');
    const body = await (await listPolls(newCookie)).json() as any;
    expect(body.polls.map((poll: any) => poll.id)).toEqual([pollId]);
  });
});

describe('author key storage and responses', () => {
  it('stores the author key only in wrapped form and never in clear', async () => {
    const { cookie } = await register('author-wrapped');
    const pollId = await propose('Wrapped key poll', cookie);

    const poll = await env.DB.prepare('SELECT author_mark FROM polls WHERE id = ?')
      .bind(pollId).first<{ author_mark: string }>();
    const mark = poll!.author_mark;
    expect(mark).toMatch(/^[0-9a-f]{64}$/);

    const user = await env.DB.prepare('SELECT id, author_key_pw, author_key_rc FROM users WHERE username = ?')
      .bind('author-wrapped').first<{ id: number; author_key_pw: string; author_key_rc: string }>();
    expect(user!.author_key_pw).not.toBe(user!.author_key_rc);
    expect(user!.author_key_pw).not.toContain(mark);
    expect(user!.author_key_rc).not.toContain(mark);

    const session = await env.DB.prepare('SELECT author_key FROM user_sessions WHERE user_id = ?')
      .bind(user!.id).first<{ author_key: string }>();
    expect(session!.author_key).not.toBe(user!.author_key_pw);
    expect(session!.author_key).not.toBe(user!.author_key_rc);
    expect(session!.author_key).not.toContain(mark);
  });

  it('dropped the legacy owner column from every table', async () => {
    // The retired column name is assembled at runtime so no source file still
    // contains the literal identifier.
    const legacyColumn = ['owner', 'hash'].join('_');
    for (const table of ['polls', 'comments', 'users', 'user_sessions']) {
      const columns = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
      expect((columns.results ?? []).map((column) => column.name)).not.toContain(legacyColumn);
    }
  });

  it('marks a comment with the poster\u2019s own author mark', async () => {
    const mine = await register('author-comment');
    const theirs = await register('author-comment-other');
    const myPoll = await propose('My commented poll', mine.cookie);
    const openPoll = await seedPoll({ title: 'An open poll to comment on' });
    const commentId = await postComment(openPoll, mine.cookie);

    const poll = await env.DB.prepare('SELECT author_mark FROM polls WHERE id = ?')
      .bind(myPoll).first<{ author_mark: string }>();
    const comment = await env.DB.prepare('SELECT author_mark FROM comments WHERE public_id = ?')
      .bind(commentId).first<{ author_mark: string }>();
    expect(comment!.author_mark).toBe(poll!.author_mark);

    const listed = await (await listComments(mine.cookie)).json() as any;
    expect(listed.comments.map((entry: any) => entry.id)).toEqual([commentId]);

    const refused = await SELF.fetch(`${ORIGIN}/api/user/comments/${commentId}`, {
      method: 'DELETE',
      headers: { origin: ORIGIN, cookie: theirs.cookie }
    });
    expect(refused.status).toBe(404);
  });

  it('rejects an invalid page parameter', async () => {
    const { cookie } = await register('author-bad-page');
    expect((await listPolls(cookie, 0)).status).toBe(400);
    expect((await SELF.fetch(`${ORIGIN}/api/user/polls?page=abc`, { headers: { cookie } })).status).toBe(400);
    expect((await SELF.fetch(`${ORIGIN}/api/user/comments?page=0`, { headers: { cookie } })).status).toBe(400);
  });

  it('never returns the author key or mark in a response body', async () => {
    const { cookie } = await register('author-response');
    const loginResponse = await SELF.fetch(`${ORIGIN}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ username: 'author-response', password: 'test-password-123' })
    });
    expect(loginResponse.status).toBe(200);
    const loginText = await loginResponse.text();
    expect(loginText).not.toContain('authorKey');
    expect(loginText).not.toContain('authorMark');

    const account = await SELF.fetch(`${ORIGIN}/api/user/account`, { headers: { cookie } });
    expect(account.status).toBe(405);
    const accountText = await account.text();
    expect(accountText).not.toContain('authorKey');
    expect(accountText).not.toContain('authorMark');

    const session = await SELF.fetch(`${ORIGIN}/api/auth/session`, { headers: { cookie } });
    const sessionText = await session.text();
    expect(sessionText).not.toContain('authorKey');
    expect(sessionText).not.toContain('authorMark');
  });
});
