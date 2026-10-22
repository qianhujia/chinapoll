// Server-rendered public pages: the document shell carries the SEO metadata and
// the crawlable body content for the routes search engines index.

import { beforeAll, describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import { ORIGIN, applySchema, seedOptions, seedPoll } from './helpers';

beforeAll(async () => {
  await applySchema();
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
    // The shell's placeholder <title> and description are replaced, not kept
    // alongside the injected ones.
    expect(html).not.toContain('<title>ChinaPoll</title>');
    expect(html.match(/name="description"/g)).toHaveLength(1);
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
    expect(html).toContain('Bike lanes on Main Street');
    expect(html).toContain('Build them');
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
});
