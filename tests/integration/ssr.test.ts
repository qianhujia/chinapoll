// Server-rendered public pages: the document shell carries the SEO metadata and
// the crawlable body content for the routes search engines index. The site is
// configured in Chinese here so the tests also prove the server-rendered copy
// follows the default locale instead of always rendering English.

import { beforeAll, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { ORIGIN, applySchema, seedOptions, seedPoll } from './helpers';
import zhDictionary from '../../public/i18n/zh.json';

// The bootstrap island the document carries, or null when the response has none.
// The keys are typed loosely here: the JSON bodies are the API responses, which
// their own tests cover in detail.
interface IslandPayload {
  settings?: Record<string, unknown>;
  locale?: string;
  i18n?: Record<string, string>;
  poll?: {
    id: number;
    commentsPage: number;
    commentsPageSize: number;
    detail?: { poll: { title: string } };
    stats?: { pollId: number; ballots: number; hidden: boolean };
    comments?: { pollId: number; total: number; comments: unknown[] };
  };
}

function islandFrom(html: string): IslandPayload | null {
  const match = html.match(/<script type="application\/json" id="bootstrap">([\s\S]*?)<\/script>/);
  return match ? JSON.parse(match[1]) as IslandPayload : null;
}

beforeAll(async () => {
  await applySchema();
  // Written before the first request so the Worker's settings cache sees it.
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('default_locale', 'zh-CN')").run();
});

describe('server-rendered pages', () => {
  it('renders the home page poll list, metadata, and structured data', async () => {
    const pollId = await seedPoll({ title: 'Should the city build more bike lanes?' });

    const response = await SELF.fetch(`${ORIGIN}/`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('Should the city build more bike lanes?');
    expect(html).toContain(`href="/poll/${pollId}"`);
    expect(html).toContain('name="description"');
    expect(html).toContain('property="og:locale"');
    expect(html).toContain('application/ld+json');
    // The hero statistics are rendered server-side instead of being fetched by
    // the SPA after the page loads.
    expect(html).toContain('data-total-votes');
    // The shell's placeholder <title> and description are replaced, not kept
    // alongside the injected ones.
    expect(html).not.toContain('<title>ChinaPoll</title>');
    expect(html.match(/name="description"/g)).toHaveLength(1);
  });

  it('renders the copy in the site default locale', async () => {
    const response = await SELF.fetch(`${ORIGIN}/about`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('<html lang="zh-CN"');
    expect(html).toContain(zhDictionary.aboutTitle);
    expect(html).toContain(zhDictionary.aboutPointOne);
    // The footer credit follows the locale as well.
    expect(html).toContain(zhDictionary.poweredBy.split('{name}')[0]);
    expect(html).not.toContain('Powered by');
    // The English dictionary must not leak into a Chinese site.
    expect(html).not.toContain('ChinaPoll combines continuous voting');
  });

  it('renders a poll page with its options', async () => {
    const pollId = await seedPoll({ title: 'Bike lanes on Main Street' });
    await seedOptions(pollId, [
      { position: 1, label: 'Build them' },
      { position: 2, label: 'Keep the road as is' }
    ]);

    const response = await SELF.fetch(`${ORIGIN}/poll/${pollId}`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('<h1');
    expect(html).toContain(`P${pollId} Bike lanes on Main Street`);
    expect(html).toContain('Build them');
    expect(html).toContain(zhDictionary.optionsLabel);
    expect(html).toContain(`rel="canonical" href="${ORIGIN}/poll/${pollId}"`);
  });

  it('renders the about page copy', async () => {
    const response = await SELF.fetch(`${ORIGIN}/about`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('id="app"');
    expect(html).not.toContain('<div id="app"></div>');
  });

  it('answers 404 for an unknown path', async () => {
    const response = await SELF.fetch(`${ORIGIN}/definitely-not-a-page`);
    expect(response.status).toBe(404);
  });

  it('answers 404 for a poll id that does not exist', async () => {
    const response = await SELF.fetch(`${ORIGIN}/poll/999999`);
    expect(response.status).toBe(404);
  });

  // The island lets the client boot without fetching the settings, the
  // dictionary, or the poll data (see worker/services/bootstrap.ts).
  it('embeds the bootstrap island with the settings, the dictionary, and the poll data', async () => {
    const pollId = await seedPoll({ title: 'Island check' });
    await seedOptions(pollId, [
      { position: 1, label: 'Yes' },
      { position: 2, label: 'No' }
    ]);

    const response = await SELF.fetch(`${ORIGIN}/poll/${pollId}`);
    const payload = islandFrom(await response.text());

    expect(response.status).toBe(200);
    expect(payload).not.toBeNull();
    // The public settings exactly as the endpoint would answer, with the private
    // rows stripped and the Turnstile fields derived from the environment.
    expect(payload!.settings).toMatchObject({
      default_locale: 'zh-CN',
      turnstile_enable: false,
      turnstile_site_key: ''
    });
    expect(payload!.settings).not.toHaveProperty('github_token');
    expect(payload!.settings).not.toHaveProperty('ai_provider');
    expect(payload!.settings).not.toHaveProperty('ai_api_url');
    expect(payload!.settings).not.toHaveProperty('ai_api_key');
    expect(payload!.settings).not.toHaveProperty('ai_model');
    expect(payload!.settings).not.toHaveProperty('publish_repository');
    // No Worker binding or server secret travels with the document: the island's
    // settings are exactly the body the endpoint answers with.
    expect(payload!.settings).not.toHaveProperty('SERVER_HMAC_KEY');
    expect(payload!.settings).not.toHaveProperty('DB');
    expect(payload!.settings).not.toHaveProperty('ASSETS');
    const endpointSettings = await (await SELF.fetch(`${ORIGIN}/api/settings/public`)).json();
    expect(payload!.settings).toEqual(endpointSettings);
    // The dictionary of the site default locale travels with the document.
    expect(payload!.locale).toBe('zh-CN');
    expect(payload!.i18n?.optionsLabel).toBe(zhDictionary.optionsLabel);
    // The poll data the page needs for its first paint, so the detail, the results,
    // and the first comment page are not requested again.
    expect(payload!.poll).toMatchObject({ id: pollId, commentsPage: 1, commentsPageSize: 30 });
    expect(payload!.poll?.detail?.poll.title).toBe('Island check');
    expect(payload!.poll?.stats).toMatchObject({ pollId, ballots: 0, hidden: true });
    expect(payload!.poll?.comments).toMatchObject({ pollId, total: 0 });
    expect(payload!.poll?.comments?.comments).toEqual([]);
  });

  it('embeds the poll data for the requested comment page only', async () => {
    const pollId = await seedPoll({ title: 'Island comment page' });

    const response = await SELF.fetch(`${ORIGIN}/poll/${pollId}?commentsPage=2`);
    const payload = islandFrom(await response.text());

    expect(payload!.poll).toMatchObject({ id: pollId, commentsPage: 2, commentsPageSize: 30 });
  });

  it('embeds no poll data for a poll page that does not exist', async () => {
    const response = await SELF.fetch(`${ORIGIN}/poll/999999`);

    expect(response.status).toBe(404);
    expect(islandFrom(await response.text())?.poll).toBeUndefined();
  });
});
