import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applySchema } from './helpers';
import {
  DEFAULT_PUBLIC_SETTINGS,
  SettingsValidationError,
  loadPublicSettings,
  publicSettingsPayload
} from '../../worker/api/settings';

async function setSetting(key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(key, value).run();
}

beforeAll(async () => {
  await applySchema();
});

describe('AI provider settings', () => {
  it('treats the legacy ai_enable row as Workers AI when no provider is stored', async () => {
    await setSetting('ai_enable', 'true');

    const settings = await loadPublicSettings(env.DB);
    expect(settings.ai_provider).toBe('cloudflare');
    expect(settings.ai_enable).toBe(true);

    // The admin page shows the same effective provider rather than Off.
    const { handleSettingsRequest } = await import('../../admin/api/settings');
    const request = new Request('https://admin.example.com/api/admin/settings');
    const response = await handleSettingsRequest(
      request,
      new URL(request.url),
      env as unknown as Parameters<typeof handleSettingsRequest>[2],
      { id: 1, username: 'admin', role: 'admin' }
    );
    const body = await response.json() as {
      settings: Array<{ key: string; value: string | null }>;
    };
    expect(body.settings.find((setting) => setting.key === 'ai_provider')?.value)
      .toBe('cloudflare');

    // Initializing the missing keys must keep the legacy Workers AI choice.
    const initRequest = new Request('https://admin.example.com/api/admin/settings/initialize', {
      method: 'POST'
    });
    const initResponse = await handleSettingsRequest(
      initRequest,
      new URL(initRequest.url),
      env as unknown as Parameters<typeof handleSettingsRequest>[2],
      { id: 1, username: 'admin', role: 'admin' }
    );
    expect(initResponse.status).toBe(200);
    const providerRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'ai_provider'")
      .first<{ value: string | null }>();
    expect(providerRow?.value).toBe('cloudflare');
  });

  it('derives the public flag from the provider and stores the endpoint settings privately', async () => {
    await setSetting('ai_provider', 'openai_compatible');
    await setSetting('ai_api_url', 'https://llm.example.com/v1');
    await setSetting('ai_api_key', 'secret-key');
    await setSetting('ai_model', 'example-model');

    const settings = await loadPublicSettings(env.DB);
    expect(settings.ai_provider).toBe('openai_compatible');
    expect(settings.ai_api_url).toBe('https://llm.example.com/v1');
    expect(settings.ai_api_key).toBe('secret-key');
    expect(settings.ai_enable).toBe(true);

    const payload = publicSettingsPayload(settings, {});
    expect(payload.ai_enable).toBe(true);
    expect(payload.ai_provider).toBeUndefined();
    expect(payload.ai_api_url).toBeUndefined();
    expect(payload.ai_api_key).toBeUndefined();
    expect(payload.ai_model).toBeUndefined();
  });

  it('turns the derived flag off when the provider is off', async () => {
    await setSetting('ai_provider', 'off');

    const settings = await loadPublicSettings(env.DB);
    expect(settings.ai_provider).toBe('off');
    expect(settings.ai_enable).toBe(false);
  });

  it('rejects an unknown provider and a non-HTTPS endpoint URL', async () => {
    await setSetting('ai_provider', 'some-other-provider');
    await expect(loadPublicSettings(env.DB)).rejects.toBeInstanceOf(SettingsValidationError);

    await setSetting('ai_provider', 'openai_compatible');
    await setSetting('ai_api_url', 'http://llm.example.com/v1');
    await expect(loadPublicSettings(env.DB)).rejects.toBeInstanceOf(SettingsValidationError);
  });

  it('keeps the default provider off', () => {
    expect(DEFAULT_PUBLIC_SETTINGS.ai_provider).toBe('off');
    expect(DEFAULT_PUBLIC_SETTINGS.ai_enable).toBe(false);
  });

  it('does not clear a stored API key when the bulk form leaves it blank', async () => {
    await setSetting('ai_provider', 'openai_compatible');
    await setSetting('ai_api_url', 'https://llm.example.com/v1');
    await setSetting('ai_api_key', 'secret-key');

    const { handleSettingsRequest } = await import('../../admin/api/settings');
    const request = new Request('https://admin.example.com/api/admin/settings/bulk', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ai_provider: 'openai_compatible', ai_api_key: '' })
    });
    const response = await handleSettingsRequest(
      request,
      new URL(request.url),
      env as unknown as Parameters<typeof handleSettingsRequest>[2],
      { id: 1, username: 'admin', role: 'admin' }
    );
    expect(response.status).toBe(200);

    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'ai_api_key'")
      .first<{ value: string }>();
    expect(row?.value).toBe('secret-key');
  });
});
