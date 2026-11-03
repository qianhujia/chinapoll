// Turnstile scope tests.
//
// The challenge covers submissions, never page views: casting a vote, signing in, creating
// an account, commenting, and reporting all verify a token, while reading a poll, its
// results, or its comments asks for none. The front end draws the widget from each form's
// submit path (see `ensureTurnstile` in src/lib/turnstile.ts), so a visitor who only reads
// the site never meets one.

import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { ORIGIN, applySchema, seedOptions, seedPoll } from './helpers';
import { handleVoteRequest } from '../../worker/api/vote';
import { handleAuthRequest } from '../../worker/api/auth';
import { handleCommentsRequest } from '../../worker/api/comments';
import { handleReportRequest } from '../../worker/api/reports';
import { handleStatsRequest } from '../../worker/api/stats';
import { DEFAULT_PUBLIC_SETTINGS } from '../../worker/api/settings';
import type { HandlerEnv } from '../../worker/index';

const SITE_KEY = '0x4AAAAAAAtest-site-key';
const SECRET_KEY = '1f2e3d4c5b6a798807162534435261708f9e0d1c2b3a495867758493a2b1c0d1';

beforeAll(async () => {
  await applySchema();
  // The vote limit is raised so the assertion meets the challenge, not the limiter.
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('vote_rate_limit', '1000/h')").run();
});

// The pool's environment plus the two keys that turn Turnstile on, so a request carrying
// no token is the one under test. The comment delay is off so the account a comment test
// registers inside the test can post immediately.
function turnstileEnv(): HandlerEnv {
  return {
    ...env,
    ...DEFAULT_PUBLIC_SETTINGS,
    user_comment_delay_minutes: 0,
    TURNSTILE_SITE_KEY: SITE_KEY,
    TURNSTILE_SECRET_KEY: SECRET_KEY
  } as unknown as HandlerEnv;
}

// The same environment without the keys, used only to create the account a comment test
// posts as: a registration through the enabled environment would need a token of its own.
function openEnv(): HandlerEnv {
  return { ...env, ...DEFAULT_PUBLIC_SETTINGS, user_comment_delay_minutes: 0 } as unknown as HandlerEnv;
}

function jsonRequest(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
    body: JSON.stringify(body)
  });
}

async function registerCookie(username: string): Promise<string> {
  const response = await handleAuthRequest(
    jsonRequest('/api/auth/register', { username, password: 'a-long-enough-password' }),
    new URL(`${ORIGIN}/api/auth/register`),
    openEnv()
  );
  expect(response.status).toBe(201);
  return (response.headers.get('set-cookie') ?? '').split(';')[0];
}

describe('Turnstile scope', () => {
  it('requires a token to cast a vote', async () => {
    const pollId = await seedPoll({ title: 'A vote behind a challenge' });
    const options = await seedOptions(pollId, [
      { position: 1, label: 'Yes' },
      { position: 2, label: 'No' }
    ]);

    const response = await handleVoteRequest(
      jsonRequest('/api/vote', { pollId, tokenHash: 'a'.repeat(64), optionIds: [options.get(1)!] }),
      turnstileEnv()
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ ok: false, message: 'turnstile verification failed' });
  });

  it('requires a token to create an account', async () => {
    const response = await handleAuthRequest(
      jsonRequest('/api/auth/register', { username: 'challenged', password: 'a-long-enough-password' }),
      new URL(`${ORIGIN}/api/auth/register`),
      turnstileEnv()
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ message: 'turnstile verification failed' });
  });

  it('requires a token to sign in', async () => {
    const response = await handleAuthRequest(
      jsonRequest('/api/auth/login', { username: 'someone', password: 'a-long-enough-password' }),
      new URL(`${ORIGIN}/api/auth/login`),
      turnstileEnv()
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ message: 'turnstile verification failed' });
  });

  it('requires a token to post a comment', async () => {
    const pollId = await seedPoll({ title: 'A comment behind a challenge' });
    const cookie = await registerCookie('challenged-commenter');

    const response = await handleCommentsRequest(
      jsonRequest('/api/comments', { pollId, comment: 'A comment worth a challenge.' }, { cookie }),
      new URL(`${ORIGIN}/api/comments`),
      turnstileEnv()
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ message: 'turnstile verification failed' });
  });

  it('requires a token to report', async () => {
    const pollId = await seedPoll({ title: 'A report behind a challenge' });

    const response = await handleReportRequest(
      jsonRequest(`/api/polls/${pollId}/report`, { reason: 'spam' }),
      new URL(`${ORIGIN}/api/polls/${pollId}/report`),
      turnstileEnv()
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ ok: false, message: 'turnstile verification failed' });
  });

  // Reading is the half that must stay free of the challenge, so that browsing a poll or
  // looking at results never asks a visitor to solve anything.
  it('asks no challenge to read a poll, its results, or its comments', async () => {
    const pollId = await seedPoll({ title: 'A poll that is only read' });

    const stats = await handleStatsRequest(
      new Request(`${ORIGIN}/api/stats/${pollId}`),
      new URL(`${ORIGIN}/api/stats/${pollId}`),
      turnstileEnv()
    );
    const comments = await handleCommentsRequest(
      new Request(`${ORIGIN}/api/comments/${pollId}`),
      new URL(`${ORIGIN}/api/comments/${pollId}`),
      turnstileEnv()
    );

    expect(stats.status).toBe(200);
    expect(comments.status).toBe(200);
  });
});