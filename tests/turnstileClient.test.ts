// Frontend Turnstile helper tests.
//
// Every widget on the public site is drawn through `renderTurnstile`, which keeps
// the box hidden by default (`appearance: 'interaction-only'`). `revealTurnstile`
// is the single path that redraws a slot visibly after the server turns a
// submission down for a missing token. The helper only reaches the DOM through
// the container it is handed and the global `window.turnstile` API, so both are
// stubbed here and the public settings are mocked to provide a site key.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config', () => ({
  getPublicSettings: () => ({ turnstile_site_key: 'site-key' })
}));

import { renderTurnstile, revealTurnstile, turnstileToken } from '../src/lib/turnstile';

interface RenderOptions {
  sitekey: string;
  appearance?: string;
  callback: (token: string) => void;
  'expired-callback'?: () => void;
  'error-callback'?: () => void;
}

interface RenderCall {
  container: HTMLElement;
  options: RenderOptions;
}

// A stand-in for the placeholder element: it only needs the two members the
// helper touches.
function makeContainer(connected = true): HTMLElement {
  return { replaceChildren: vi.fn(), isConnected: connected } as unknown as HTMLElement;
}

// Lets the microtasks queued by `revealTurnstile`'s fire-and-forget re-render run.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('frontend Turnstile helper', () => {
  const renderCalls: RenderCall[] = [];
  const removed: string[] = [];

  beforeEach(() => {
    renderCalls.length = 0;
    removed.length = 0;
    let nextId = 0;
    const api = {
      render: (container: HTMLElement, options: RenderOptions): string => {
        renderCalls.push({ container, options });
        nextId += 1;
        return `widget-${nextId}`;
      },
      reset: vi.fn(),
      remove: (id?: string): void => {
        if (id) removed.push(id);
      }
    };
    (globalThis as unknown as Record<string, unknown>).window = { turnstile: api };
  });

  it('renders the interaction-only appearance by default', async () => {
    await renderTurnstile('vote', makeContainer());

    expect(renderCalls).toHaveLength(1);
    expect(renderCalls[0].options.appearance).toBe('interaction-only');
  });

  it('keeps the token the widget callback reports', async () => {
    await renderTurnstile('vote', makeContainer());

    renderCalls[0].options.callback('token-1');
    expect(turnstileToken('vote')).toBe('token-1');

    // An expiry clears it again so a stale token is never submitted.
    renderCalls[0].options['expired-callback']?.();
    expect(turnstileToken('vote')).toBe('');
  });

  it('redraws a hidden slot in the always appearance when revealed', async () => {
    const container = makeContainer();
    await renderTurnstile('report', container);

    revealTurnstile('report');
    await flush();

    // The hidden widget is removed and replaced by a visible one.
    expect(removed).toEqual(['widget-1']);
    expect(renderCalls).toHaveLength(2);
    expect(renderCalls[1].options.appearance).toBe('always');
    expect(renderCalls[1].container).toBe(container);
  });

  it('leaves a slot that is already visible untouched', async () => {
    await renderTurnstile('visible', makeContainer(), 'always');

    revealTurnstile('visible');
    await flush();

    expect(removed).toEqual([]);
    expect(renderCalls).toHaveLength(1);
  });

  it('does not reveal a slot whose container left the document', async () => {
    await renderTurnstile('detached', makeContainer(false));

    revealTurnstile('detached');
    await flush();

    expect(removed).toEqual([]);
    expect(renderCalls).toHaveLength(1);
  });
});
