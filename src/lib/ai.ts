// Client for the optional AI assistance endpoints.
//
// The endpoints are only available when the `ai_enable` setting is on; when it
// is off they answer 404 and the buttons are not rendered at all. The draft is
// sent to the Worker, which forwards it to Cloudflare Workers AI; nothing is
// stored on either side.

import { fetchJson, type PollType } from './poll';

export type AiLocale = 'en' | 'zh-CN' | 'zh-TW';

export async function enhanceTitle(payload: {
  title: string;
  description?: string;
  locale: AiLocale;
  turnstileToken?: string;
}): Promise<{ suggestions: string[] }> {
  return fetchJson('/api/ai/enhance-title', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export async function suggestOptions(payload: {
  title: string;
  description?: string;
  pollType: PollType;
  count?: number;
  locale: AiLocale;
  turnstileToken?: string;
}): Promise<{ options: string[] }> {
  return fetchJson('/api/ai/suggest-options', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

// Asks for one category slug, or `none` when nothing fits.
export async function categorise(payload: {
  title: string;
  description?: string;
  turnstileToken?: string;
}): Promise<{ slug: string }> {
  return fetchJson('/api/ai/categorise', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}
