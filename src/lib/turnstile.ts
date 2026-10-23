// Turnstile widget integration.
//
// The script is loaded once, lazily, and only when a site key is configured.
// Each widget is registered under a "slot" so a page with several forms can read
// and reset the right token. If the widget cannot load, submissions still go
// through and the server decides whether a token is required.

import { getPublicSettings } from '../config';

interface TurnstileApi {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      'expired-callback'?: () => void;
      'error-callback'?: () => void;
    }
  ) => string;
  reset: (widgetId?: string) => void;
}

declare global {
  interface Window { turnstile?: TurnstileApi }
}

const widgets = new Map<string, { id: string; token: string }>();
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

export async function renderTurnstile(slot: string, container: HTMLElement): Promise<void> {
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
    widgets.set(slot, { id, token: '' });
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