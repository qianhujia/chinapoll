// Feed route tests.
//
// The poll list is served as RSS and as JSON Feed from the Worker itself, with the head of
// every document advertising both. A poll the public cannot see never reaches a feed.

import { beforeAll, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { ORIGIN, applySchema, seedPoll } from './helpers';

beforeAll(async () => {
  await applySchema();
});

describe('feeds', () => {
  it('serves the poll list as RSS', async () => {
    const pollId = await seedPoll({ title: 'A poll for the RSS feed' });
    await env.DB.prepare('UPDATE polls SET number = ? WHERE id = ?').bind(pollId + 1000, pollId).run();

    const response = await SELF.fetch(`${ORIGIN}/feed.xml`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/rss+xml');
    // A reader may poll often, so the response is shared-cached rather than answered
    // from the database every time.
    expect(response.headers.get('cache-control')).toBe('public, max-age=600');
    expect(body).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(body).toContain(`<link>${ORIGIN}/poll/${pollId + 1000}</link>`);
    expect(body).toContain('A poll for the RSS feed');
  });

  it('serves the same list as JSON Feed', async () => {
    const pollId = await seedPoll({ title: 'A poll for the JSON feed' });
    await env.DB.prepare('UPDATE polls SET number = ? WHERE id = ?').bind(pollId + 1000, pollId).run();

    const response = await SELF.fetch(`${ORIGIN}/feed.json`);
    const feed = await response.json() as { version: string; feed_url: string; items: Array<{ url: string; title: string }> };

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/feed+json');
    expect(feed.version).toBe('https://jsonfeed.org/version/1.1');
    expect(feed.feed_url).toBe(`${ORIGIN}/feed.json`);
    expect(feed.items.map((item) => item.url)).toContain(`${ORIGIN}/poll/${pollId + 1000}`);
    expect(feed.items.map((item) => item.title)).toContain(`#${pollId + 1000} A poll for the JSON feed`);
  });

  it('leaves a pending poll out of both feeds', async () => {
    const pollId = await seedPoll({ title: 'A poll still under review', status: 4 });
    await env.DB.prepare('UPDATE polls SET number = ? WHERE id = ?').bind(pollId + 1000, pollId).run();

    const rss = await (await SELF.fetch(`${ORIGIN}/feed.xml`)).text();
    const json = await (await SELF.fetch(`${ORIGIN}/feed.json`)).text();

    expect(rss).not.toContain('A poll still under review');
    expect(json).not.toContain('A poll still under review');
  });

  it('advertises both feeds in the document head', async () => {
    const html = await (await SELF.fetch(`${ORIGIN}/`)).text();

    expect(html).toContain(`<link rel="alternate" type="application/rss+xml" title="ChinaPoll" href="${ORIGIN}/feed.xml" />`);
    expect(html).toContain(`<link rel="alternate" type="application/feed+json" title="ChinaPoll" href="${ORIGIN}/feed.json" />`);
  });
});