// The bootstrap island: the settings, translation dictionary, and poll data the
// Worker embeds in the document so the client does not fetch them right after the
// load. The server-side builders are pure, and the client reader is exercised with
// a stubbed document so both halves are covered without a browser.

import { afterEach, describe, expect, it, vi } from 'vitest';
import zhDictionary from '../public/i18n/zh.json';
import { bootstrapPoll, readBootstrap, BOOTSTRAP_ELEMENT_ID } from '../src/bootstrap';
import { DEFAULT_PUBLIC_SETTINGS, publicSettingsPayload } from '../worker/api/settings';
import type { PublicSettings } from '../worker/api/settings';
import {
  buildBootstrapPayload,
  injectBootstrapScript,
  renderBootstrapScript,
  type BootstrapPayload
} from '../worker/services/bootstrap';
import type { HandlerEnv } from '../worker/index';
import { serializeJsonScript } from '../worker/services/html';
import { dictionaryFor } from '../worker/services/ssr';
import { getPublicSettings, isValidPublicSettings, loadPublicSettings } from '../src/config';
import { getLocaleText, loadTranslations } from '../src/i18n';

const settings = { ...DEFAULT_PUBLIC_SETTINGS } as PublicSettings;

// Extracts the island's JSON from a rendered document.
function islandJson(html: string): Record<string, unknown> {
  const match = html.match(/<script type="application\/json" id="bootstrap">([\s\S]*?)<\/script>/);
  if (!match) throw new Error('no bootstrap island in the document');
  return JSON.parse(match[1]) as Record<string, unknown>;
}

// Stands in for the parsed document: the reader only needs getElementById.
function stubIsland(textContent: string | null): void {
  vi.stubGlobal('document', {
    getElementById: (id: string) => (id === BOOTSTRAP_ELEMENT_ID && textContent !== null ? { textContent } : null)
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('bootstrap island serialization', () => {
  it('escapes markup so a value cannot close the element', () => {
    const hostile = '</script><script>alert(1)</script>';
    // Only "<" needs escaping: it covers both "</script" and "<!--".
    expect(serializeJsonScript({ title: hostile }))
      .toBe('{"title":"\\u003c/script>\\u003cscript>alert(1)\\u003c/script>"}');
    expect(serializeJsonScript({ title: hostile })).not.toContain('</script');
  });

  it('round-trips the payload through the document', () => {
    const payload: BootstrapPayload = {
      settings: { site_name: 'ChinaPoll' },
      locale: 'zh-CN',
      i18n: { optionsLabel: '选项' },
      poll: { id: 7, commentsPage: 1, commentsPageSize: 30, detail: { poll: { id: 7 } } }
    };

    const html = injectBootstrapScript('<html><body><div id="app"></div></body></html>', renderBootstrapScript(payload));

    expect(html).toContain(`<script type="application/json" id="${BOOTSTRAP_ELEMENT_ID}">`);
    expect(html.indexOf('id="bootstrap"')).toBeLessThan(html.indexOf('</body>'));
    expect(islandJson(html)).toEqual(payload);
  });

  it('leaves a shell without a body unchanged', () => {
    expect(injectBootstrapScript('<html></html>', '<script></script>')).toBe('<html></html>');
  });
});

describe('bootstrap island payload', () => {
  it('strips the private settings and adds the Turnstile fields', () => {
    const env = { TURNSTILE_SITE_KEY: 'site-key', TURNSTILE_SECRET_KEY: 'secret-key' };
    const payload = publicSettingsPayload(
      { ...settings, ai_model: 'private-model', github_token: 'private-token' } as PublicSettings,
      env
    );

    expect(payload).not.toHaveProperty('ai_model');
    expect(payload).not.toHaveProperty('github_token');
    expect(payload).not.toHaveProperty('publish_repository');
    expect(payload.turnstile_enable).toBe(true);
    expect(payload.turnstile_site_key).toBe('site-key');
    expect(payload.site_name).toBe(DEFAULT_PUBLIC_SETTINGS.site_name);
  });

  it('validates like the settings API response, so the island is only used when it matches', () => {
    expect(isValidPublicSettings(publicSettingsPayload(settings, {}))).toBe(true);
    expect(isValidPublicSettings({ ...settings, polls_per_page: 0 })).toBe(false);
    expect(isValidPublicSettings({ ...settings, turnstile_enable: 'yes' })).toBe(false);
    expect(isValidPublicSettings(null)).toBe(false);
    expect(isValidPublicSettings([])).toBe(false);
  });

  it('embeds the dictionary of one locale', () => {
    expect(dictionaryFor('zh-CN')).toEqual(zhDictionary);
    expect(dictionaryFor('zh')).toEqual(zhDictionary);
  });

  it('never serializes the environment bindings or the server secret', async () => {
    // A regression guard: building the payload from the merged handler environment
    // would put every binding and SERVER_HMAC_KEY into the document.
    const merged = {
      ...settings,
      SERVER_HMAC_KEY: 'server-secret',
      DB: {},
      ASSETS: {},
      RATE_LIMITER: {},
      PASSWORD_HASHER: {},
      VIEW_COUNTER: {},
      AI: {}
    } as unknown as HandlerEnv;

    const payload = await buildBootstrapPayload(merged, settings, 'https://example.com');

    const privateKeys = [
      'ai_provider', 'ai_api_url', 'ai_api_key',
      'ai_model', 'ai_rate_limit', 'ai_auto_topic', 'ai_review_prompt',
      'publish_enable', 'publish_repository', 'publish_branch', 'publish_path',
      'github_token'
    ];
    const publicKeys = Object.keys(DEFAULT_PUBLIC_SETTINGS).filter((key) => !privateKeys.includes(key));
    expect(Object.keys(payload.settings).sort())
      .toEqual([...publicKeys, 'turnstile_enable', 'turnstile_site_key'].sort());
    expect(payload.settings).not.toHaveProperty('SERVER_HMAC_KEY');
    expect(payload.settings).not.toHaveProperty('DB');
    expect(payload.settings).not.toHaveProperty('ASSETS');
    expect(payload.locale).toBe(settings.default_locale);
  });
});

describe('bootstrap island reader', () => {
  it('has no island without a document', () => {
    expect(readBootstrap()).toBeNull();
    expect(bootstrapPoll(7, 1, 30)).toBeNull();
  });

  it('reads the payload and rejects a malformed one', () => {
    stubIsland(JSON.stringify({ locale: 'zh-CN', i18n: { optionsLabel: '选项' } }));
    expect(readBootstrap()?.locale).toBe('zh-CN');

    stubIsland('not json');
    expect(readBootstrap()).toBeNull();

    stubIsland('[1,2]');
    expect(readBootstrap()).toBeNull();
  });

  it('matches only the view it describes', () => {
    stubIsland(JSON.stringify({ poll: { id: 7, commentsPage: 1, commentsPageSize: 30 } }));
    expect(bootstrapPoll(7, 1, 30)).toEqual({ id: 7, commentsPage: 1, commentsPageSize: 30 });
    // Another poll, another comment page, or another page size means the client
    // fetches instead of rendering stale data.
    expect(bootstrapPoll(8, 1, 30)).toBeNull();
    expect(bootstrapPoll(7, 2, 30)).toBeNull();
    expect(bootstrapPoll(7, 1, 15)).toBeNull();
  });

  it('lets the client boot without fetching the settings or the dictionary', async () => {
    stubIsland(JSON.stringify({
      settings: publicSettingsPayload(settings, {}),
      locale: 'en',
      i18n: { optionsLabel: 'Options' }
    }));
    const fetchSpy = vi.fn(() => {
      throw new Error('the island should make this request unnecessary');
    });
    vi.stubGlobal('fetch', fetchSpy);

    await loadPublicSettings();
    await loadTranslations('en');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getPublicSettings().site_name).toBe(DEFAULT_PUBLIC_SETTINGS.site_name);
    expect(getLocaleText('en', 'optionsLabel')).toBe('Options');
  });

  it('falls back to the API when the island is unusable', async () => {
    // An island whose settings do not validate (here: a page size of 0) must be
    // ignored rather than reach the UI.
    stubIsland(JSON.stringify({
      settings: { ...publicSettingsPayload(settings, {}), polls_per_page: 0 },
      locale: 'en'
    }));
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ...publicSettingsPayload(settings, {}), site_name: 'From the API' })
    }));
    vi.stubGlobal('fetch', fetchSpy);

    await loadPublicSettings();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(getPublicSettings().site_name).toBe('From the API');
  });
});
