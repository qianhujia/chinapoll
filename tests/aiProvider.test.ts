import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  openAiChatCompletionsUrl,
  runModel,
  type AiEnv
} from '../worker/services/ai';

const MESSAGES = [{ role: 'user', content: 'Return JSON.' }];
const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };

function aiEnv(overrides: Partial<AiEnv> = {}): AiEnv {
  return {
    AI: { run: vi.fn() } as unknown as AiEnv['AI'],
    ai_provider: 'openai_compatible',
    ai_api_url: 'https://api.example.com/v1',
    ai_api_key: 'test-key',
    ...overrides
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AI provider routing', () => {
  it('builds a chat-completions URL from a base URL or a full endpoint', () => {
    expect(openAiChatCompletionsUrl('https://api.openai.com/v1'))
      .toBe('https://api.openai.com/v1/chat/completions');
    expect(openAiChatCompletionsUrl('https://api.openai.com/v1/'))
      .toBe('https://api.openai.com/v1/chat/completions');
    expect(openAiChatCompletionsUrl('https://api.example.com/chat/completions'))
      .toBe('https://api.example.com/chat/completions');
  });

  it('calls an OpenAI-compatible endpoint with the shared model and API key', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.example.com/v1/chat/completions');
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe('Bearer test-key');
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.model).toBe('gpt-test-model');
      expect(body.messages).toEqual(MESSAGES);
      expect(body.response_format).toEqual({ type: 'json_object' });
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"ok":true}' } }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runModel(
      aiEnv(), 'gpt-test-model', MESSAGES, SCHEMA, new AbortController().signal
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toBe('{"ok":true}');
  });

  it('omits the authorization header when no API key is configured', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBeUndefined();
      return new Response(JSON.stringify({
        choices: [{ message: { content: { ok: true } } }]
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runModel(
      aiEnv({ ai_api_key: '' }), 'gpt-test-model', MESSAGES, SCHEMA, new AbortController().signal
    );

    expect(result).toEqual({ ok: true });
  });

  it('rejects when the endpoint answers with an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('provider details', { status: 500 })));

    await expect(runModel(
      aiEnv(), 'gpt-test-model', MESSAGES, SCHEMA, new AbortController().signal
    )).rejects.toThrow('OpenAI-compatible API answered 500');
  });

  it('keeps using the Workers AI binding for the Cloudflare provider', async () => {
    const run = vi.fn(async () => ({ ok: true }));
    const env = aiEnv({ ai_provider: 'cloudflare', AI: { run } as unknown as AiEnv['AI'] });

    const result = await runModel(
      env, '@cf/test-model', MESSAGES, SCHEMA, new AbortController().signal
    );

    expect(run).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true });
  });

  it('refuses to call a model while the provider is off', async () => {
    await expect(runModel(
      aiEnv({ ai_provider: 'off' }), 'gpt-test-model', MESSAGES, SCHEMA,
      new AbortController().signal
    )).rejects.toThrow('AI provider is not configured');
  });
});
