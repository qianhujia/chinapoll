// Frontend Turnstile helper tests.
//
// Every widget on the public site is drawn through `renderTurnstile`, which keeps
// the box hidden by default (`appearance: 'interaction-only'`) and holds it back
// until a submission asks for a token (`execution: 'execute'`).
// `obtainTurnstileToken` is the single path that asks, and `revealTurnstile` is the
// single path that redraws a slot visibly after the server turns a submission down
// for a missing token. The helper only reaches the DOM through the container it is
// handed and the global `window.turnstile` API, so both are stubbed here and the
// public settings are mocked to provide a site key.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config', () => ({
  getPublicSettings: () => ({ turnstile_site_key: 'site-key' })
}));

import { obtainTurnstileToken, renderTurnstile, revealTurnstile } from '../src/lib/turnstile';

interface RenderOptions {
  sitekey: string;
  appearance?: string;
  execution?: string;
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
  const executed: string[] = [];

  beforeEach(() => {
    renderCalls.length = 0;
    removed.length = 0;
    executed.length = 0;
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
      },
      execute: (id?: string): void => {
        if (id) executed.push(id);
      }
    };
    (globalThis as unknown as Record<string, unknown>).window = { turnstile: api };
  });

  it('draws the widget silently and defers running it', async () => {
    await renderTurnstile('vote', makeContainer());

    expect(renderCalls).toHaveLength(1);
    expect(renderCalls[0].options.appearance).toBe('interaction-only');
    // The widget waits for a request, so no token is minted at page load and left
    // to expire before the visitor submits.
    expect(renderCalls[0].options.execution).toBe('execute');
    expect(executed).toEqual([]);
  });

  it('resolves an empty token when no widget was drawn', async () => {
    // No site key, or a script that never loaded: the server keeps deciding
    // whether a token is required.
    await expect(obtainTurnstileToken('missing')).resolves.toBe('');
  });

  it('runs the widget on demand and resolves with the token it reports', async () => {
    await renderTurnstile('vote', makeContainer());

    const pending = obtainTurnstileToken('vote');
    expect(executed).toEqual(['widget-1']);
    renderCalls[0].options.callback('token-1');

    await expect(pending).resolves.toBe('token-1');
  });

  it('reuses a token that is already at hand', async () => {
    await renderTurnstile('vote', makeContainer());
    renderCalls[0].options.callback('token-1');

    await expect(obtainTurnstileToken('vote')).resolves.toBe('token-1');
    // Nothing had to run again.
    expect(executed).toEqual([]);
  });

  it('rejects when the widget reports an error and reruns after an expiry', async () => {
    await renderTurnstile('vote', makeContainer());

    const pending = obtainTurnstileToken('vote');
    renderCalls[0].options['error-callback']?.();
    await expect(pending).rejects.toThrow();

    // An expired token is dropped, so the next request runs the widget again.
    renderCalls[0].options.callback('token-2');
    renderCalls[0].options['expired-callback']?.();
    const again = obtainTurnstileToken('vote');
    expect(executed).toEqual(['widget-1', 'widget-1']);
    renderCalls[0].options.callback('token-3');

    await expect(again).resolves.toBe('token-3');
  });

  it('rejects when the widget never answers', async () => {
    await renderTurnstile('vote', makeContainer());

    await expect(obtainTurnstileToken('vote', 5)).rejects.toThrow();
  });

  it('redraws a hidden slot visibly and runs it when revealed', async () => {
    const container = makeContainer();
    await renderTurnstile('report', container);

    revealTurnstile('report');
    await flush();

    // The hidden widget is removed and replaced by a visible one, which is executed
    // at once so the box the visitor has to solve actually runs.
    expect(removed).toEqual(['widget-1']);
    expect(renderCalls).toHaveLength(2);
    expect(renderCalls[1].options.appearance).toBe('always');
    expect(renderCalls[1].options.execution).toBe('execute');
    expect(renderCalls[1].container).toBe(container);
    expect(executed).toEqual(['widget-2']);
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
