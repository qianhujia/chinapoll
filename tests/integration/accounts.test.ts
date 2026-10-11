import { beforeAll, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { ORIGIN, applySchema, seedPoll } from './helpers';

beforeAll(async () => {
  await applySchema();
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

function postComment(pollId: number, cookie: string, origin = ORIGIN): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, cookie },
    body: JSON.stringify({ pollId, comment: 'A comment on this public poll.' })
  });
}

describe('account gates', () => {
  it('blocks a new account, then allows a comment once the delay passes', async () => {
    const pollId = await seedPoll({ title: 'Comment delay poll' });
    const cookie = await register('commenter');

    const early = await postComment(pollId, cookie);
    expect(early.status).toBe(403);

    // Backdate the account past the default 24-hour comment delay.
    await env.DB.prepare('UPDATE users SET created_at = created_at - 25 * 3600 WHERE username = ?')
      .bind('commenter').run();

    const later = await postComment(pollId, cookie);
    expect(later.status).toBe(201);
  });

  it('rejects a cookie-authenticated mutation from another origin', async () => {
    const pollId = await seedPoll({ title: 'CSRF poll' });
    const cookie = await register('csrf-user');

    const rejected = await postComment(pollId, cookie, 'https://evil.example');
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({ message: 'cross-origin request rejected' });
  });
});
