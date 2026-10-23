// Application errors carry a stable code (plus structured params) next to the
// legacy English message, so the frontend can render them in the visitor's
// language. These tests also pin the backward-compatible `message` text.

import { beforeAll, describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import { ORIGIN, applySchema, choiceVoteRequest, seedOptions, seedPoll } from './helpers';

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

describe('api error codes', () => {
  it('codes an unknown API path', async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/does-not-exist`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: 'RESOURCE_NOT_FOUND', params: {} },
      message: 'not found'
    });
  });

  it('codes a wrong method', async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/polls`, { method: 'POST' });
    expect(response.status).toBe(405);
    expect(await response.json()).toMatchObject({
      error: { code: 'METHOD_NOT_ALLOWED' },
      message: 'method not allowed'
    });
  });

  it('codes a rejected cross-origin mutation', async () => {
    const pollId = await seedPoll({ title: 'Coded csrf poll' });
    const cookie = await register('coded-csrf');

    const rejected = await SELF.fetch(`${ORIGIN}/api/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example', cookie },
      body: JSON.stringify({ pollId, comment: 'A comment on this public poll.' })
    });
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({
      error: { code: 'CROSS_ORIGIN_REJECTED' },
      message: 'cross-origin request rejected'
    });
  });

  it('codes invalid credentials without revealing whether the account exists', async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ username: 'nobody-here', password: 'test-password-123' })
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: 'INVALID_CREDENTIALS', params: {} },
      message: 'invalid username or password'
    });
  });

  it('codes a field-level password rule with its parameters', async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ username: 'short-password', password: 'tiny' })
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: 'PASSWORD_TOO_SHORT', params: { min: 12 } },
      message: 'password must be at least 12 characters'
    });
  });

  it('codes a username rule with its parameters', async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ username: 'No', password: 'test-password-123' })
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: 'USERNAME_INVALID', params: { min: 3, max: 32 } },
      message: 'username must be 3-32 lowercase characters (letters, digits, dot, underscore, hyphen)'
    });
  });

  it('codes a taken username', async () => {
    await register('taken-name');
    const response = await SELF.fetch(`${ORIGIN}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ username: 'taken-name', password: 'test-password-123' })
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'USERNAME_TAKEN', params: {} },
      message: 'username is already taken'
    });
  });

  it('codes an unknown vote option and keeps ok:false', async () => {
    const pollId = await seedPoll({ title: 'Coded option poll' });
    const options = await seedOptions(pollId, [
      { position: 1, label: 'Yes' },
      { position: 2, label: 'No' }
    ]);

    const response = await choiceVoteRequest(pollId, 'b'.repeat(64), [options.get(1)! + 999]);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: 'UNKNOWN_OPTION', params: {} },
      message: 'unknown option'
    });
  });

  it('codes a poll that is not open', async () => {
    const pollId = await seedPoll({ title: 'Coded closed poll', status: 2, closedAt: 1 });
    const options = await seedOptions(pollId, [
      { position: 1, label: 'Yes' },
      { position: 2, label: 'No' }
    ]);

    const response = await choiceVoteRequest(pollId, 'c'.repeat(64), [options.get(1)!]);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: 'POLL_NOT_OPEN' },
      message: 'poll is not open'
    });
  });
});
