import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { ORIGIN, applySchema } from './helpers';
import { DEFAULT_PUBLIC_SETTINGS } from '../../worker/api/settings';
import { PollStatus } from '../../worker/enums';
import type { HandlerEnv } from '../../worker/index';

// The proposal handler is called directly with an explicit settings object, so
// each test can change `auto_approve_polls`, the AI provider, and the review prompt
// without waiting for the Worker's 30 second settings cache. Only one account is
// registered, because the tests share a network bucket.
let cookie = '';

const OPTIONS = [
  { position: 1, label: 'Approve' },
  { position: 2, label: 'Neutral' },
  { position: 3, label: 'Oppose' }
];

let aiCalls = 0;
let modelResponse: unknown = { approve: true };
let lastMessages: Array<{ role: string; content: string }> = [];

const stubAI = {
  run: async (_model: string, options: { messages: Array<{ role: string; content: string }> }) => {
    aiCalls += 1;
    lastMessages = options.messages;
    return modelResponse;
  }
};

beforeAll(async () => {
  await applySchema();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('register_rate_limit', '1000/d')"),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('user_poll_delay_minutes', '0')"),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('proposal_rate_limit', '1000/d')")
  ]);
  const registered = await SELF.fetch(`${ORIGIN}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ username: 'review-proposer', password: 'test-password-123' })
  });
  expect(registered.status).toBe(201);
  cookie = (registered.headers.get('set-cookie') ?? '').split(';')[0];
});

afterEach(() => {
  aiCalls = 0;
  modelResponse = { approve: true };
  lastMessages = [];
  (env as unknown as { AI: unknown }).AI = stubAI;
});

function handlerEnv(overrides: Record<string, unknown>): HandlerEnv {
  return {
    ...env,
    ...DEFAULT_PUBLIC_SETTINGS,
    // The real binding needs a remote connection, so every call in this file
    // uses the canned answer instead.
    AI: stubAI,
    ai_provider: 'cloudflare',
    ai_model: 'test-model',
    ai_rate_limit: '1000/h',
    proposal_rate_limit: '1000/d',
    user_poll_delay_minutes: 0,
    ...overrides
  } as unknown as HandlerEnv;
}

async function propose(settings: Record<string, unknown>, title: string): Promise<Response> {
  const { handleProposalRequest } = await import('../../worker/api/proposal');
  return handleProposalRequest(new Request(`${ORIGIN}/api/proposal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
    body: JSON.stringify({
      title,
      description: 'A description that is long enough to pass validation.',
      pollType: 'single_choice',
      duration: 'none',
      options: OPTIONS
    })
  }), handlerEnv(settings));
}

async function pollStatus(pollId: number): Promise<number | null> {
  const row = await env.DB.prepare('SELECT status FROM polls WHERE id = ?')
    .bind(pollId).first<{ status: number }>();
  return row ? Number(row.status) : null;
}

describe('proposal submission without the server key', () => {
  it('still stores the poll, because ownership no longer depends on the server key', async () => {
    const title = 'Poll with no server key';
    const response = await propose({ SERVER_HMAC_KEY: undefined }, title);

    expect(response.status).toBe(201);
    const pollId = Number((await response.json() as { pollId: number }).pollId);

    // The row carries the submitter's author mark, so the submitter can still list
    // and manage it even though the deployment has no server key.
    const row = await env.DB.prepare('SELECT author_mark FROM polls WHERE id = ?')
      .bind(pollId).first<{ author_mark: string | null }>();
    expect(row?.author_mark).toMatch(/^[0-9a-f]{64}$/);

    const listed = await (await SELF.fetch(`${ORIGIN}/api/user/polls?page=1`, { headers: { cookie } }))
      .json() as any;
    expect(listed.polls.map((poll: any) => poll.id)).toContain(pollId);
  });
});

describe('AI review of auto-approved proposals', () => {
  it('publishes a submission the model approves', async () => {
    const response = await propose({
      auto_approve_polls: true,
      ai_enable: true,
      ai_review_prompt: 'Publish factual polls only.'
    }, 'Approved review poll');

    expect(response.status).toBe(201);
    const body = await response.json() as { pollId: number; status: string };
    expect(body.status).toBe('open');
    expect(await pollStatus(body.pollId)).toBe(PollStatus.Open);
    expect(aiCalls).toBe(1);

    // The admin prompt and the submission both reach the model.
    const prompt = lastMessages.map((message) => message.content).join('\n');
    expect(prompt).toContain('Publish factual polls only.');
    expect(prompt).toContain('Approved review poll');
    expect(prompt).toContain('Approve, Neutral, Oppose');
  });

  it('leaves a submission pending when the model rejects it', async () => {
    modelResponse = { approve: false, reason: 'not neutral' };
    const response = await propose({
      auto_approve_polls: true,
      ai_enable: true,
      ai_review_prompt: 'Publish neutral polls only.'
    }, 'Rejected review poll');

    expect(response.status).toBe(201);
    const body = await response.json() as { pollId: number; status: string };
    expect(body.status).toBe('pending');
    expect(await pollStatus(body.pollId)).toBe(PollStatus.Pending);
    expect(aiCalls).toBe(1);
  });

  it('leaves a submission pending when the model answer is unusable', async () => {
    modelResponse = { approve: 'yes' };
    const response = await propose({
      auto_approve_polls: true,
      ai_enable: true,
      ai_review_prompt: 'Publish neutral polls only.'
    }, 'Bad review output poll');

    const body = await response.json() as { pollId: number; status: string };
    expect(body.status).toBe('pending');
    expect(await pollStatus(body.pollId)).toBe(PollStatus.Pending);
  });

  it('publishes immediately when AI is off even if a prompt is stored', async () => {
    const response = await propose({
      auto_approve_polls: true,
      ai_provider: 'off',
      ai_review_prompt: 'Publish factual polls only.'
    }, 'AI off review poll');

    const body = await response.json() as { pollId: number; status: string };
    expect(body.status).toBe('open');
    expect(await pollStatus(body.pollId)).toBe(PollStatus.Open);
    expect(aiCalls).toBe(0);
  });

  it('publishes immediately when the review prompt is empty or blank', async () => {
    for (const [index, prompt] of ['', '   \n '].entries()) {
      const response = await propose({
        auto_approve_polls: true,
        ai_enable: true,
        ai_review_prompt: prompt
      }, `Empty prompt review poll ${index}`);

      const body = await response.json() as { pollId: number; status: string };
      expect(body.status).toBe('open');
      expect(await pollStatus(body.pollId)).toBe(PollStatus.Open);
    }
    expect(aiCalls).toBe(0);
  });

  it('never reviews when auto-approval is off', async () => {
    const response = await propose({
      auto_approve_polls: false,
      ai_enable: true,
      ai_review_prompt: 'Publish factual polls only.'
    }, 'Auto approval off review poll');

    const body = await response.json() as { pollId: number; status: string };
    expect(body.status).toBe('pending');
    expect(await pollStatus(body.pollId)).toBe(PollStatus.Pending);
    expect(aiCalls).toBe(0);
  });
});
