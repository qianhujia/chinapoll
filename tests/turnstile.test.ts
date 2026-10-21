import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getTurnstileConfig,
  isTurnstileEnabled,
  turnstileSecretKey,
  turnstileSiteKey,
  verifyTurnstile
} from '../worker/services/turnstile';

// Stubs the Turnstile siteverify endpoint with a canned answer.
function siteverify(payload: unknown, status = 200): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Turnstile configuration', () => {
  it('is enabled only when both keys are set', () => {
    expect(isTurnstileEnabled({})).toBe(false);
    expect(isTurnstileEnabled({ TURNSTILE_SITE_KEY: 'site-key' })).toBe(false);
    expect(isTurnstileEnabled({ TURNSTILE_SECRET_KEY: 'secret-key' })).toBe(false);
    expect(isTurnstileEnabled({ TURNSTILE_SITE_KEY: 'site-key', TURNSTILE_SECRET_KEY: 'secret-key' })).toBe(true);
  });

  it('treats a blank key as unset', () => {
    expect(isTurnstileEnabled({ TURNSTILE_SITE_KEY: '   ', TURNSTILE_SECRET_KEY: 'secret-key' })).toBe(false);
    expect(isTurnstileEnabled({ TURNSTILE_SITE_KEY: 'site-key', TURNSTILE_SECRET_KEY: '' })).toBe(false);
    expect(turnstileSiteKey({ TURNSTILE_SITE_KEY: ' site-key ' })).toBe('site-key');
    expect(turnstileSecretKey({ TURNSTILE_SECRET_KEY: ' secret-key ' })).toBe('secret-key');
  });

  it('reports the site key together with the enabled flag', () => {
    expect(getTurnstileConfig({ TURNSTILE_SITE_KEY: 'site-key', TURNSTILE_SECRET_KEY: 'secret-key' }))
      .toEqual({ enabled: true, siteKey: 'site-key' });
    expect(getTurnstileConfig({})).toEqual({ enabled: false, siteKey: '' });
  });
});

describe('Turnstile hostname verification', () => {
  it('accepts a token solved on the expected host', async () => {
    siteverify({ success: true, hostname: 'chinapoll.org' });
    expect(await verifyTurnstile('secret', 'token', 'chinapoll.org')).toBe(true);
  });

  it('rejects a token solved on another host', async () => {
    siteverify({ success: true, hostname: 'evil.example' });
    expect(await verifyTurnstile('secret', 'token', 'chinapoll.org')).toBe(false);
  });

  it('does not require a hostname when none is expected', async () => {
    siteverify({ success: true, hostname: 'evil.example' });
    expect(await verifyTurnstile('secret', 'token')).toBe(true);
  });

  it('rejects a failed verification regardless of hostname', async () => {
    siteverify({ success: false, hostname: 'chinapoll.org' });
    expect(await verifyTurnstile('secret', 'token', 'chinapoll.org')).toBe(false);
  });
});
