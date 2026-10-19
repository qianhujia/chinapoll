import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyTurnstile } from '../worker/services/turnstile';

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
