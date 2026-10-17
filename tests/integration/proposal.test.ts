import { beforeAll, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { ORIGIN, applySchema } from './helpers';

// The proposal endpoint requires a signed-in account, so one session is created
// once and reused for every request in this file.
let cookie = '';

beforeAll(async () => {
  await applySchema();
  // A generous window keeps the functional tests from tripping the limits; the
  // rate limits themselves are covered elsewhere.
  await env.DB.batch([
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('proposal_rate_limit', '1000/d')"),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('register_rate_limit', '1000/d')"),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('user_poll_delay_hours', '0')")
  ]);
  const registered = await SELF.fetch(`${ORIGIN}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ username: 'proposer', password: 'test-password-123' })
  });
  expect(registered.status).toBe(201);
  cookie = (registered.headers.get('set-cookie') ?? '').split(';')[0];
});

interface ProposalBody {
  title: string;
  description?: string;
  pollType: string;
  duration: string;
  options?: Array<{ position: number; label: string }>;
}

function propose(body: Partial<ProposalBody>): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/proposal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
    body: JSON.stringify({ pollType: 'verdict', duration: 'none', ...body })
  });
}

interface PollRow {
  mode: number;
  poll_type: number;
  duration_seconds: number | null;
  start_at: number | null;
  end_at: number | null;
  status: number;
}

function pollRow(pollId: number): Promise<PollRow | null> {
  return env.DB.prepare(
    'SELECT mode, poll_type, duration_seconds, start_at, end_at, status FROM polls WHERE id = ?'
  ).bind(pollId).first<PollRow>();
}

describe('proposal validation', () => {
  it('requires a duration from the seven labels', async () => {
    const missing = await exceed(async () => {
      const body: Partial<ProposalBody> = { title: 'No duration poll' };
      const { duration, ...rest } = body as ProposalBody;
      void duration;
      return SELF.fetch(`${ORIGIN}/api/proposal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
        body: JSON.stringify(rest)
      });
    });
    expect(missing.status).toBe(400);

    const bad = await propose({ title: 'Bad duration poll', duration: '2w' });
    expect(bad.status).toBe(400);
  });

  it('rejects a choice poll with too few options and a verdict poll with options', async () => {
    expect((await propose({
      title: 'Too few options',
      pollType: 'single_choice',
      options: [{ position: 1, label: 'Only one' }]
    })).status).toBe(400);

    expect((await propose({
      title: 'Verdict with options',
      pollType: 'verdict',
      options: [{ position: 1, label: 'A' }, { position: 2, label: 'B' }]
    })).status).toBe(400);
  });
});

// A tiny helper so the missing-duration case can omit the field entirely.
async function exceed(task: () => Promise<Response>): Promise<Response> {
  return task();
}

describe('stored duration model', () => {
  it('stores an evergreen poll for the "none" duration and writes no start time', async () => {
    const response = await propose({ title: 'Evergreen proposal' });
    expect(response.status).toBe(201);
    const body = await response.json() as any;
    expect(body.pollType).toBe('verdict');

    const row = await pollRow(body.pollId);
    // Mode 2 is evergreen; 1 is deadline.
    expect(row?.mode).toBe(2);
    expect(row?.duration_seconds).toBeNull();
    expect(row?.start_at).toBeNull();
    expect(row?.end_at).toBeNull();
  });

  it('stores a deadline poll with the mapped duration in seconds and mode deadline', async () => {
    const response = await propose({ title: 'Thirty day proposal', duration: '1m' });
    expect(response.status).toBe(201);
    const body = await response.json() as any;

    const row = await pollRow(body.pollId);
    expect(row?.mode).toBe(1);
    expect(row?.duration_seconds).toBe(30 * 86_400);
    // The end date is computed when the poll opens, not at submission; without
    // auto-approval this poll stays pending until an admin approves it.
    expect(row?.start_at).toBeNull();
    expect(row?.status).toBe(4);
  });
});

describe('choice poll proposals', () => {
  it('stores the options of a pending choice poll', async () => {
    const response = await propose({
      title: 'Choice proposal',
      pollType: 'multi_choice',
      duration: '7d',
      options: [
        { position: 1, label: 'Bus' },
        { position: 2, label: 'Metro' }
      ]
    });
    expect(response.status).toBe(201);
    const body = await response.json() as any;
    expect(body.pollType).toBe('multi_choice');

    const row = await pollRow(body.pollId);
    expect(row?.poll_type).toBe(3);
    expect(row?.duration_seconds).toBe(7 * 86_400);
    expect(row?.status).toBe(4);
    expect(row?.end_at).toBeNull();

    const options = await env.DB.prepare(
      'SELECT position, label FROM poll_options WHERE poll_id = ? ORDER BY position ASC'
    ).bind(body.pollId).all<{ position: number; label: string }>();
    expect(options.results).toEqual([
      { position: 1, label: 'Bus' },
      { position: 2, label: 'Metro' }
    ]);
  });

  it('sets the end date when the poll opens and never moves it again', async () => {
    const response = await propose({ title: 'Admin opened poll', duration: '3d' });
    const body = await response.json() as any;
    const before = Math.floor(Date.now() / 1000);

    const { handlePollsRequest } = await import('../../admin/api/polls');
    const url = new URL(`https://admin.example.com/api/admin/polls/${body.pollId}/status`);
    const open = () => handlePollsRequest(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'open' })
    }), url, env, { id: 1, username: 'admin', role: 'admin' });

    const opened = await open();
    expect(opened.status).toBe(200);

    const row = await pollRow(body.pollId);
    expect(row?.status).toBe(1);
    expect(row?.end_at).not.toBeNull();
    // The end date is close to now plus three days.
    expect((row?.end_at ?? 0) - before).toBeGreaterThanOrEqual(3 * 86_400 - 5);
    expect((row?.end_at ?? 0) - before).toBeLessThanOrEqual(3 * 86_400 + 60);

    // Re-opening an open poll must not move an end date that is already stored.
    const endAt = row?.end_at;
    await open();
    expect((await pollRow(body.pollId))?.end_at).toBe(endAt);
  });

  it('refuses to publish a choice poll that has no options', async () => {
    // A choice poll submitted without options is rejected at validation time.
    expect((await propose({
      title: 'Empty options poll', pollType: 'single_choice', duration: '1d', options: []
    })).status).toBe(400);

    // A poll whose options were removed afterwards cannot be opened either.
    const created = await propose({
      title: 'Later emptied poll', pollType: 'single_choice', duration: '1d',
      options: [{ position: 1, label: 'A' }, { position: 2, label: 'B' }]
    });
    const emptyId = (await created.json() as any).pollId as number;
    await env.DB.prepare('DELETE FROM poll_options WHERE poll_id = ?').bind(emptyId).run();

    const { handlePollsRequest } = await import('../../admin/api/polls');
    const url = new URL(`https://admin.example.com/api/admin/polls/${emptyId}/status`);
    const refused = await handlePollsRequest(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'open' })
    }), url, env, { id: 1, username: 'admin', role: 'admin' });
    expect(refused.status).toBe(422);
    expect((await pollRow(emptyId))?.status).toBe(4);
  });
});
