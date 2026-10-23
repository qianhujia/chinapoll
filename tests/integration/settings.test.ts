// Public settings endpoint: the Turnstile fields are derived from the Worker
// environment, so the private key never reaches the browser and a leftover row in
// the settings table cannot turn the feature back on.

import { beforeAll, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { handlePublicSettingsRequest } from '../../worker/api/settings';
import { ORIGIN, applySchema } from './helpers';

const SITE_KEY = '0x4AAAAAAAtest-site-key';
const SECRET_KEY = '1f2e3d4c5b6a798807162534435261708f9e0d1c2b3a495867758493a2b1c0d1';

beforeAll(async () => {
  await applySchema();
});

// Calls the handler with an explicit environment, so the test does not depend on
// the Worker's own bindings. The pool leaves both Turnstile variables unset, which
// is also what keeps every other integration test free of tokens.
function publicSettingsResponse(envVars: Record<string, string>): Promise<Response> {
  return handlePublicSettingsRequest(
    new Request(`${ORIGIN}/api/settings/public`),
    { DB: env.DB, ...envVars }
  );
}

describe('public settings: Turnstile', () => {
  it('reports Turnstile as disabled while the keys are unset', async () => {
    const settings = await (await SELF.fetch(`${ORIGIN}/api/settings/public`)).json() as Record<string, unknown>;
    expect(settings.turnstile_enable).toBe(false);
    expect(settings.turnstile_site_key).toBe('');
  });

  it('enables Turnstile only when both keys are configured', async () => {
    const siteKeyOnly = await (await publicSettingsResponse({ TURNSTILE_SITE_KEY: SITE_KEY })).json() as Record<string, unknown>;
    expect(siteKeyOnly.turnstile_enable).toBe(false);

    const secretKeyOnly = await (await publicSettingsResponse({ TURNSTILE_SECRET_KEY: SECRET_KEY })).json() as Record<string, unknown>;
    expect(secretKeyOnly.turnstile_enable).toBe(false);

    const both = await (await publicSettingsResponse({
      TURNSTILE_SITE_KEY: SITE_KEY,
      TURNSTILE_SECRET_KEY: SECRET_KEY
    })).json() as Record<string, unknown>;
    expect(both.turnstile_enable).toBe(true);
    expect(both.turnstile_site_key).toBe(SITE_KEY);
  });

  it('never exposes the Turnstile secret key', async () => {
    const settings = await (await publicSettingsResponse({
      TURNSTILE_SITE_KEY: SITE_KEY,
      TURNSTILE_SECRET_KEY: SECRET_KEY
    })).json() as Record<string, unknown>;
    expect(settings.turnstile_secret_key).toBeUndefined();
    expect(JSON.stringify(settings)).not.toContain(SECRET_KEY);
  });

  // An uploaded image is stored as a base64 data URI but reaches the public site
  // as a short versioned URL served by the branding endpoint, so the payload never
  // travels in the settings document. Versioning by update time keeps a replaced
  // image out of an immutable browser cache.
  it('serves an uploaded logo from the image endpoint', async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('logo', ?, 1700000000)")
        .bind('data:image/png;base64,AQIDBA==')
    ]);

    const settings = await (await SELF.fetch(`${ORIGIN}/api/settings/public`)).json() as Record<string, unknown>;
    expect(settings.logo).toBe('/image/logo.png?v=1700000000');

    const image = await SELF.fetch(`${ORIGIN}/image/logo.png?v=1700000000`);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    // The response keeps its own cache headers instead of the Worker's no-store.
    expect(image.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(Array.from(new Uint8Array(await image.arrayBuffer()))).toEqual([1, 2, 3, 4]);
  });

  // A pasted URL is used by the pages directly, so the site serves it as it is and
  // the branding endpoint has nothing to answer with.
  it('serves a pasted favicon URL as it is', async () => {
    const url = 'https://cdn.example.com/favicon.png';
    await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('favicon', ?)").bind(url).run();

    const settings = await (await SELF.fetch(`${ORIGIN}/api/settings/public`)).json() as Record<string, unknown>;
    expect(settings.favicon).toBe(url);

    expect((await SELF.fetch(`${ORIGIN}/favicon.ico`)).status).toBe(404);
  });

  it('ignores legacy Turnstile rows left in the settings table', async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('turnstile_enable', 'true')"),
      env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('turnstile_site_key', '0x4AAAAAAlegacy')"),
      env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('turnstile_secret_key', ?)").bind(SECRET_KEY)
    ]);

    const settings = await (await SELF.fetch(`${ORIGIN}/api/settings/public`)).json() as Record<string, unknown>;
    expect(settings.turnstile_enable).toBe(false);
    expect(settings.turnstile_site_key).toBe('');
  });
});
