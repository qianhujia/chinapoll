// "My polls" endpoints.
//
// A poll stores one fixed `author_mark` per account, so "my polls" is an ordinary
// paginated query: it lists only the polls the account submitted, never a poll the
// account merely voted on, and never another account's poll.

import { beforeAll, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { ORIGIN, applySchema, choiceVoteRequest, seedOptions, seedPoll } from './helpers';

beforeAll(async () => {
  await applySchema();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('register_rate_limit', '1000/d')"),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('proposal_rate_limit', '1000/d')"),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('vote_rate_limit', '1000/h')"),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('user_poll_delay_minutes', '0')"),
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

function closePoll(pollId: number, cookie: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/user/polls/${pollId}/close`, {
    method: 'POST',
    headers: { origin: ORIGIN, cookie }
  });
}

function withdrawPoll(pollId: number, cookie: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/user/polls/${pollId}`, {
    method: 'DELETE',
    headers: { origin: ORIGIN, cookie }
  });
}

describe('my polls', () => {
  it('lists the polls the account submitted and no other poll', async () => {
    const mine = await register('poll-author');
    const theirs = await register('poll-stranger');
    const myPoll = await propose('My own poll', mine);
    await propose('Someone else poll', theirs);

    const body = await (await listPolls(mine)).json() as any;
    expect(body.polls.map((poll: any) => poll.id)).toEqual([myPoll]);
    expect(body.polls[0]).toMatchObject({ id: myPoll, title: 'My own poll' });
    expect(body.hasMore).toBe(false);

    // The other account sees only its own poll.
    const other = await (await listPolls(theirs)).json() as any;
    expect(other.polls.map((poll: any) => poll.title)).toEqual(['Someone else poll']);
  });

  // A poll the account voted on belongs to whoever submitted it, so it is never part
  // of "my polls".
  it('does not list a poll the account only voted on', async () => {
    const cookie = await register('poll-voter');
    const pollId = await seedPoll({ title: 'Voted on, not submitted' });
    const options = await seedOptions(pollId, [
      { position: 1, label: 'Yes' },
      { position: 2, label: 'No' }
    ]);
    expect((await choiceVoteRequest(pollId, 'f'.repeat(64), [options.get(1)!])).status).toBe(200);

    const body = await (await listPolls(cookie)).json() as any;
    expect(body.polls).toEqual([]);
    // The poll stays public; it is simply not owned by this account.
    const listing = await (await SELF.fetch(`${ORIGIN}/api/polls/${pollId}`)).json() as any;
    expect(listing.poll.id).toBe(pollId);
  });

  it('closes and withdraws only the account\u2019s own poll', async () => {
    const mine = await register('poll-closer');
    const theirs = await register('poll-owner');
    const myPoll = await propose('Close me', mine);
    const theirPoll = await propose('Not yours', theirs);

    // A stranger's poll is a 404 rather than an action.
    expect((await closePoll(theirPoll, mine)).status).toBe(404);
    expect((await withdrawPoll(theirPoll, mine)).status).toBe(404);

    const closed = await closePoll(myPoll, mine);
    expect(closed.status).toBe(200);
    expect(await closed.json()).toMatchObject({ ok: true, pollId: myPoll, status: 'closed' });

    // Withdrawing is for polls still under review, so the closed one is refused.
    expect((await withdrawPoll(myPoll, mine)).status).toBe(409);

    // A pending poll of mine can be withdrawn, and it leaves the list.
    const pending = await propose('Withdraw me', mine);
    expect((await withdrawPoll(pending, mine)).status).toBe(200);
    const body = await (await listPolls(mine)).json() as any;
    expect(body.polls.map((poll: any) => poll.id)).not.toContain(pending);
  });

  it('rejects an invalid page and asks for a session', async () => {
    const cookie = await register('poll-page-checker');
    expect((await listPolls(cookie, 0)).status).toBe(400);
    expect((await SELF.fetch(`${ORIGIN}/api/user/polls?page=abc`, { headers: { cookie } })).status).toBe(400);
    expect((await SELF.fetch(`${ORIGIN}/api/user/polls`)).status).toBe(401);
  });
});
