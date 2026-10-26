// Turnstile widget integration.
//
// The script is loaded once, lazily, and only when a site key is configured.
// Each widget is registered under a "slot" so a page with several forms obtains
// and resets the right token. If the widget cannot load, submissions still go
// through with an empty token and the server decides whether a token is required.
//
// A token is asked for on demand rather than read from a cache at click time. The
// widget renders in execute mode (`execution: 'execute'`) with a silent default
// appearance, the submit handler awaits `obtainTurnstileToken(slot)`, and the
// widget runs then. That is what keeps a submission from carrying an empty token
// (the callback had not fired yet) or an expired one (a token lives about five
// minutes). A token already in hand is reused; a challenge Cloudflare demands is
// shown and solved while the handler waits; the promise rejects on an error or a
// timeout, and the handler reports that like any other submit failure.
//
// The box stays hidden unless Cloudflare needs an interaction, and a hidden widget
// hides its own errors too, so a flow that receives a TURNSTILE_FAILED response
// calls `revealTurnstile`: the slot is redrawn visibly and executed at once, so the
// visitor can solve it before trying again.

import { getPublicSettings } from '../config';

// Turnstile's documented appearance modes. 'interaction-only' is the silent
// default described above; 'always' is used only when a challenge must be shown.
export type TurnstileAppearance = 'always' | 'execute' | 'interaction-only';

// How the widget decides to run. 'execute' means it waits for `turnstile.execute`
// instead of running as soon as it is rendered, which is what lets a submit handler
// ask for a token and wait for it.
export type TurnstileExecution = 'render' | 'execute';

interface TurnstileApi {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      'expired-callback'?: () => void;
      'error-callback'?: () => void;
      appearance?: TurnstileAppearance;
      execution?: TurnstileExecution;
    }
  ) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId?: string) => void;
  execute: (widgetId?: string) => void;
}

declare global {
  interface Window { turnstile?: TurnstileApi }
}

// A caller waiting for a token. It settles once: the widget callback resolves it,
// an error or the timeout rejects it, and a newer request supersedes it.
interface TokenRequest {
  resolve: (token: string) => void;
  reject: (error: Error) => void;
  settled: boolean;
}

interface RegisteredWidget {
  id: string;
  token: string;
  container: HTMLElement;
  appearance: TurnstileAppearance;
  /** The request the next callback answer belongs to, or null when nobody waits. */
  pending: TokenRequest | null;
}

const widgets = new Map<string, RegisteredWidget>();
let scriptPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Turnstile script failed to load'));
      document.head.appendChild(script);
    });
  }
  return scriptPromise;
}

export function turnstileSiteKey(): string {
  return getPublicSettings().turnstile_site_key;
}

// Draws the widget into `container`. The default appearance keeps the box hidden
// until Cloudflare needs an interaction, so most visitors never see it.
export async function renderTurnstile(
  slot: string,
  container: HTMLElement,
  appearance: TurnstileAppearance = 'interaction-only'
): Promise<void> {
  const siteKey = turnstileSiteKey();
  if (!siteKey || !container) return;
  try {
    await loadScript();
    const api = window.turnstile;
    // Without the API object there is no widget to draw, so the placeholder the
    // page reserved for it is emptied rather than left showing its loading text.
    if (!api) {
      container.replaceChildren();
      return;
    }
    // Drop any placeholder the page painted so the widget fills the slot the page
    // already reserved for it instead of stacking on top of the placeholder.
    container.replaceChildren();
    // The record is stored before the widget is drawn, so a callback that fired
    // during the render still finds the slot it belongs to.
    const registered: RegisteredWidget = { id: '', token: '', container, appearance, pending: null };
    widgets.set(slot, registered);
    registered.id = api.render(container, {
      sitekey: siteKey,
      appearance,
      // The widget runs only when it is asked to, so no token is minted at page
      // load and left to expire before the visitor submits.
      execution: 'execute',
      callback: (token: string) => {
        registered.token = token;
        registered.pending?.resolve(token);
      },
      'expired-callback': () => {
        // A token is spent once it expires; the next submission asks for a new one.
        registered.token = '';
      },
      'error-callback': () => {
        registered.token = '';
        registered.pending?.reject(new Error('Turnstile could not verify the visitor'));
      }
    });
  } catch {
    // A script that never loads leaves the token empty and the server decides
    // whether one is required; the placeholder is emptied so a form never keeps
    // showing a loading note for a widget that will not arrive.
    container.replaceChildren();
  }
}

// Awaits a token for `slot`, asking the widget to run when nothing is at hand.
//
// A slot without a widget (no site key is configured, or the script never loaded)
// resolves with an empty string, so the server keeps deciding whether a token is
// required. A cached token is returned at once. Otherwise the widget is executed
// and the promise settles when the callback answers, when the widget reports an
// error, or when the timeout elapses.
export function obtainTurnstileToken(slot: string, timeoutMs = 15_000): Promise<string> {
  const widget = widgets.get(slot);
  if (!widget || widget.token) return Promise.resolve(widget?.token ?? '');

  const api = window.turnstile;
  if (!api) return Promise.resolve('');

  return new Promise<string>((resolve, reject) => {
    // A request that is still waiting (a warm-up, for example) cannot be answered
    // once this one takes the slot, so it is settled rather than left hanging.
    widget.pending?.reject(new Error('Turnstile request superseded'));

    const request: TokenRequest = {
      settled: false,
      resolve: (token: string) => {
        if (request.settled) return;
        request.settled = true;
        clearTimeout(timer);
        if (widget.pending === request) widget.pending = null;
        resolve(token);
      },
      reject: (error: Error) => {
        if (request.settled) return;
        request.settled = true;
        clearTimeout(timer);
        if (widget.pending === request) widget.pending = null;
        reject(error);
      }
    };
    const timer = setTimeout(() => request.reject(new Error('Turnstile timed out')), timeoutMs);
    widget.pending = request;

    try {
      api.execute(widget.id);
    } catch (error) {
      request.reject(error instanceof Error ? error : new Error('Turnstile could not run'));
    }
  });
}

export function resetTurnstile(slot: string): void {
  const widget = widgets.get(slot);
  if (!widget) return;
  widget.token = '';
  window.turnstile?.reset(widget.id);
}

// Restarts a slot in a visible appearance after the server rejected a submission
// for a missing or invalid token. The silent default hides the box, so this is the
// one path that surfaces it for the visitor to solve. The redrawn widget waits for
// a request like every other one, so it is executed at once: the visible box then
// actually runs, and the token it produces is cached for the next submission. A
// slot that is already visible, or whose container left the document, is untouched.
export function revealTurnstile(slot: string): void {
  const widget = widgets.get(slot);
  if (!widget || widget.appearance === 'always') return;
  if (!widget.container.isConnected) return;
  window.turnstile?.remove(widget.id);
  widgets.delete(slot);
  void renderTurnstile(slot, widget.container, 'always').then(() => {
    const redrawn = widgets.get(slot);
    if (redrawn) window.turnstile?.execute(redrawn.id);
  });
}