// Turnstile widget integration.
//
// The script is loaded once, lazily, and only when a site key is configured.
// Each widget is registered under a "slot" so a page with several forms can read
// and reset the right token. If the widget cannot load, submissions still go
// through and the server decides whether a token is required.
//
// Widgets render silently by default (`appearance: 'interaction-only'`): the box
// stays hidden unless Cloudflare decides an interactive challenge is required.
// A hidden widget also hides its own errors, so a flow that receives a
// TURNSTILE_FAILED response calls `revealTurnstile` and the box appears for the
// visitor to solve.

import { getPublicSettings } from '../config';

// Turnstile's documented appearance modes. 'interaction-only' is the silent
// default described above; 'always' is used only when a challenge must be shown.
export type TurnstileAppearance = 'always' | 'execute' | 'interaction-only';

interface TurnstileApi {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      'expired-callback'?: () => void;
      'error-callback'?: () => void;
      appearance?: TurnstileAppearance;
    }
  ) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId?: string) => void;
}

declare global {
  interface Window { turnstile?: TurnstileApi }
}

interface RegisteredWidget {
  id: string;
  token: string;
  container: HTMLElement;
  appearance: TurnstileAppearance;
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
    const id = api.render(container, {
      sitekey: siteKey,
      appearance,
      callback: (token: string) => {
        const widget = widgets.get(slot);
        if (widget) widget.token = token;
      },
      'expired-callback': () => {
        const widget = widgets.get(slot);
        if (widget) widget.token = '';
      },
      'error-callback': () => {
        const widget = widgets.get(slot);
        if (widget) widget.token = '';
      }
    });
    widgets.set(slot, { id, token: '', container, appearance });
  } catch {
    // A script that never loads leaves the token empty and the server decides
    // whether one is required; the placeholder is emptied so a form never keeps
    // showing a loading note for a widget that will not arrive.
    container.replaceChildren();
  }
}

export function turnstileToken(slot: string): string {
  return widgets.get(slot)?.token ?? '';
}

export function resetTurnstile(slot: string): void {
  const widget = widgets.get(slot);
  if (!widget) return;
  widget.token = '';
  window.turnstile?.reset(widget.id);
}

// Restarts a slot in a visible appearance after the server rejected a submission
// for a missing or invalid token. The silent default hides the box, so this is
// the one path that surfaces it for the visitor to solve; the fresh token then
// arrives through the same callback as before. A slot that is already visible, or
// whose container left the document, is left untouched.
export function revealTurnstile(slot: string): void {
  const widget = widgets.get(slot);
  if (!widget || widget.appearance === 'always') return;
  if (!widget.container.isConnected) return;
  window.turnstile?.remove(widget.id);
  widgets.delete(slot);
  void renderTurnstile(slot, widget.container, 'always');
}