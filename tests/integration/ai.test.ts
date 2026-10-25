import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { ORIGIN, applySchema } from './helpers';

// The real model cannot be called from the pool, so `env.AI` is stubbed with an
// object whose `run` returns canned JSON. `runModel` in worker/services/ai.ts is
// the only place the binding is touched, so this covers the whole path.
//
// `ai_provider` is written in `beforeAll`, before the first request, because the
// Worker caches its merged settings in memory for 30 seconds.
interface StubAi {
  run: (model: string, options: unknown) => Promise<unknown>;
}

let modelResponse: unknown = { suggestions: [] };
let modelError: Error | null = null;

const stubAI: StubAi = {
  run: async () => {
    if (modelError) throw modelError;
    return modelResponse;
  }
};

async function register(username: string): Promise<string> {
  const result = await SELF.fetch(`${ORIGIN}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ username, password: 'test-password-123' })
  });
  expect(result.status).toBe(201);
  return (result.headers.get('set-cookie') ?? '').split(';')[0];
}

function aiRequest(path: string, cookie: string, body: Record<string, unknown>, origin = ORIGIN): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, cookie },
    body: JSON.stringify(body)
  });
}

// One session is registered once and reused: registration is limited per network
// bucket, and the tests share the same bucket.
let sessionCookie = '';

async function session(): Promise<string> {
  if (!sessionCookie) sessionCookie = await register('ai-user');
  return sessionCookie;
}

const TITLE_BODY = {
  title: 'Should the city fund a new tram line',
  locale: 'en'
};

beforeAll(async () => {
  await applySchema();
  // Everything a test needs is written before the first request, because the
  // Worker caches the merged settings for 30 seconds inside one isolate.
  await env.DB.batch([
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('ai_rate_limit', '1000/h')"),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('user_poll_delay_minutes', '0')"),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('register_rate_limit', '1000/d')"),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('ai_model', 'test-model')"),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('ai_review_prompt', 'private review instructions')"),
    // The feature is on for every request made in this isolate.
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('ai_provider', 'cloudflare')")
  ]);
});

afterEach(() => {
  modelResponse = { suggestions: [] };
  modelError = null;
  (env as unknown as { AI: unknown }).AI = stubAI;
});

describe('AI assistance endpoints', () => {
  // The Worker caches the merged settings per isolate, so the provider-off case
  // cannot share an isolate with the enabled cases. The handler is called
  // directly with the defaults instead, which is exactly the state before an
  // admin selects a provider.
  it('answers 404 while the AI provider is off', async () => {
    const { handleAiRequest } = await import('../../worker/api/ai');
    const { DEFAULT_PUBLIC_SETTINGS } = await import('../../worker/api/settings');
    const request = new Request(`${ORIGIN}/api/ai/enhance-title`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify(TITLE_BODY)
    });
    const result = await handleAiRequest(
      request,
      new URL(request.url),
      { ...(env as any), ...DEFAULT_PUBLIC_SETTINGS }
    );
    expect(result.status).toBe(404);
    expect(await result.json()).toMatchObject({ message: 'not found' });
    expect(DEFAULT_PUBLIC_SETTINGS.ai_enable).toBe(false);
    expect(DEFAULT_PUBLIC_SETTINGS.ai_provider).toBe('off');
  });

  it('answers 401 without a session', async () => {
    const result = await SELF.fetch(`${ORIGIN}/api/ai/enhance-title`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify(TITLE_BODY)
    });
    expect(result.status).toBe(401);
  });

  it('rejects an oversize title and description with 400', async () => {
    const cookie = await session();

    expect((await aiRequest('/api/ai/enhance-title', cookie, {
      title: 'x'.repeat(201), locale: 'en'
    })).status).toBe(400);
    expect((await aiRequest('/api/ai/enhance-title', cookie, {
      title: 'A long enough title', description: 'y'.repeat(2001), locale: 'en'
    })).status).toBe(400);
    expect((await aiRequest('/api/ai/enhance-title', cookie, {
      title: 'short', locale: 'en'
    })).status).toBe(400);
    expect((await aiRequest('/api/ai/enhance-title', cookie, {
      title: 'A long enough title', locale: 'fr'
    })).status).toBe(400);
  });
});

describe('AI model output validation', () => {
  it('returns 502 for a malformed model answer', async () => {
    const cookie = await session();

    // Not an object, no field, wrong item type, markdown, duplicates, over-long,
    // and an empty list are all rejected.
    const badValues: unknown[] = [
      'plain text',
      { suggestions: 'not an array' },
      { suggestions: [1, 2] },
      { suggestions: ['**bold** title'] },
      { suggestions: ['Same title', 'same title'] },
      { suggestions: ['x'.repeat(201)] },
      { suggestions: [] }
    ];
    for (const value of badValues) {
      modelResponse = value;
      const result = await aiRequest('/api/ai/enhance-title', cookie, TITLE_BODY);
      expect(result.status).toBe(502);
      const body = await result.json() as any;
      // The generic message never leaks the model output.
      expect(body.message).toBe('the model returned an unusable answer');
    }
  });

  it('trims a valid answer and caps it at three suggestions', async () => {
    const cookie = await session();

    modelResponse = {
      suggestions: [
        '  Should the city fund a new tram line?  ',
        'Is a new tram line the right investment?',
        'Should the city build the tram now?',
        // A fourth suggestion is dropped by the parser.
        'Should the city spend on the tram?'
      ]
    };
    const result = await aiRequest('/api/ai/enhance-title', cookie, TITLE_BODY);
    expect(result.status).toBe(200);
    const body = await result.json() as any;
    expect(body.ok).toBe(true);
    expect(body.suggestions).toHaveLength(3);
    expect(body.suggestions[0]).toBe('Should the city fund a new tram line?');

    modelResponse = { options: ['Bus', 'Metro', 'Bike'] };
    const options = await aiRequest('/api/ai/suggest-options', cookie, {
      title: 'Preferred transit mode',
      pollType: 'single_choice',
      count: 3,
      locale: 'en'
    });
    expect(options.status).toBe(200);
    expect(await options.json()).toMatchObject({ ok: true, options: ['Bus', 'Metro', 'Bike'] });
  });

  it('accepts a JSON string answer and the { response } wrapper', async () => {
    const cookie = await session();

    modelResponse = JSON.stringify({ suggestions: ['Should the city fund a new tram line?'] });
    expect((await aiRequest('/api/ai/enhance-title', cookie, TITLE_BODY)).status).toBe(200);

    modelResponse = { response: { suggestions: ['Should the city build the tram now?'] } };
    expect((await aiRequest('/api/ai/enhance-title', cookie, TITLE_BODY)).status).toBe(200);
  });
});

describe('AI failure handling', () => {
  it('returns 504 when the model times out', async () => {
    const cookie = await session();
    modelError = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

    const result = await aiRequest('/api/ai/enhance-title', cookie, TITLE_BODY);
    expect(result.status).toBe(504);
  });

  it('returns 502 for any other model failure', async () => {
    const cookie = await session();
    modelError = new Error('model unavailable');

    const result = await aiRequest('/api/ai/enhance-title', cookie, TITLE_BODY);
    expect(result.status).toBe(502);
  });

  it('rejects a cross-origin request and a verdict poll type', async () => {
    const cookie = await session();

    const crossOrigin = await aiRequest('/api/ai/enhance-title', cookie, TITLE_BODY, 'https://evil.example');
    expect(crossOrigin.status).toBe(403);

    const verdict = await aiRequest('/api/ai/suggest-options', cookie, {
      title: 'A long enough title', pollType: 'verdict', locale: 'en'
    });
    expect(verdict.status).toBe(400);
  });

  it('never exposes the private AI settings publicly', async () => {

    const publicSettings = await (await SELF.fetch(`${ORIGIN}/api/settings/public`)).json() as any;
    expect(publicSettings.ai_enable).toBe(true);
    expect(publicSettings.ai_provider).toBeUndefined();
    expect(publicSettings.ai_api_url).toBeUndefined();
    expect(publicSettings.ai_api_key).toBeUndefined();
    expect(publicSettings.ai_model).toBeUndefined();
    expect(publicSettings.ai_rate_limit).toBeUndefined();
    expect(publicSettings.ai_review_prompt).toBeUndefined();
    expect(JSON.stringify(publicSettings)).not.toContain('private review instructions');
    expect(publicSettings.ai_review_prompt).toBeUndefined();
  });
});
