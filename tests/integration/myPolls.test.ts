// "My polls" endpoints.
//
// A poll keeps a one-way owner hash derived from the account and the poll id, so "my
// polls" lists only the polls the account submitted - never a poll the account merely
// voted on, and never another account's poll. The client supplies the ids it
// remembers, and the server answers only for rows whose owner hash matches.

import { beforeAll, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { ORIGIN, applySchema, choiceVoteRequest, seedOptions, seedPoll } from './helpers';

beforeAll(async () => {
  await applySchema();
  // The file registers several accounts and submits several polls; the gates
  // themselves are covered elsewhere.
  await env.DB.batch([
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('register_rate_limit', '1000/d')"),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('proposal_rate_limit', '1000/d')"),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('vote_rate_limit', '1000/h')"),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('user_poll_delay_hours', '0')"),
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
  // Backdate the account so the submission delay never applies.
  await env.DB.prepare('UPDATE users SET created_at = created_at - 25 * 3600 WHERE username = ?')
    .bind(username).run();
  return (response.headers.get('set-cookie') ?? '').split(';')[0];
}

// Submits a poll through the public API and returns its id.
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

function listPolls(ids: number[], cookie: string): Promise<Response> {
  const params = new URLSearchParams({ ids: ids.join(',') });
  return SELF.fetch(`${ORIGIN}/api/user/polls?${params}`, { headers: { cookie } });
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
    const theirPoll = await propose('Someone else poll', theirs);

    const body = await (await listPolls([myPoll, theirPoll], mine)).json() as any;
    expect(body.polls.map((poll: any) => poll.id)).toEqual([myPoll]);
    expect(body.polls[0]).toMatchObject({ id: myPoll, title: 'My own poll' });

    // The other account sees its own poll and not mine.
    const other = await (await listPolls([myPoll, theirPoll], theirs)).json() as any;
    expect(other.polls.map((poll: any) => poll.id)).toEqual([theirPoll]);
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

    const body = await (await listPolls([pollId], cookie)).json() as any;
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
    const body = await (await listPolls([pending], mine)).json() as any;
    expect(body.polls).toEqual([]);
  });

  it('rejects a malformed id list and asks for a session', async () => {
    const cookie = await register('poll-id-checker');
    expect((await listPolls([0], cookie)).status).toBe(400);
    expect(await (await listPolls([], cookie)).json()).toEqual({ polls: [] });
    expect((await SELF.fetch(`${ORIGIN}/api/user/polls?ids=1`)).status).toBe(401);
  });
});

