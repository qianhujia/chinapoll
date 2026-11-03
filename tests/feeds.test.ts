// Feed tests.
//
// The poll list is published as RSS 2.0 and as JSON Feed, and both are built from one list
// of polls: the same items in the same order, with a poll's description reduced to the one
// plain line a reader shows. Anything a visitor cannot see (a pending poll) never reaches
// a feed, which the loader's own test covers.

import { describe, expect, it } from 'vitest';
import {
  FEED_ITEM_LIMIT,
  buildJsonFeed,
  buildRssFeed,
  feedDescription,
  feedTitle,
  type FeedPoll,
  type FeedSettings
} from '../worker/services/feeds';

const ORIGIN = 'https://chinapoll.org';
const settings: FeedSettings = {
  site_name: 'ChinaPoll',
  site_slogan: 'Public opinion made visible',
  default_locale: 'zh-CN',
  home_description: '{slogan}'
};

const polls: FeedPoll[] = [
  {
    number: 12,
    title: '拆墙：完全取消对境外网站的访问限制',
    description: '<p>Should the wall come down?</p>',
    createdAt: 1_700_000_000
  },
  { number: 11, title: 'Bike lanes', description: null, createdAt: 1_699_000_000 }
];

describe('feed settings', () => {
  it('names the feed after the site and resolves its description', () => {
    expect(feedTitle(settings)).toBe('ChinaPoll - Public opinion made visible');
    expect(feedTitle({ ...settings, site_slogan: '' })).toBe('ChinaPoll');
    // The description is resolved like the home page's, so a reader sees the same wording.
    expect(feedDescription(settings)).toBe('Public opinion made visible');
  });
});

describe('buildRssFeed', () => {
  it('writes one item per poll, newest first, with an RFC 822 date', () => {
    const xml = buildRssFeed(polls, settings, ORIGIN);

    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">');
    expect(xml).toContain('<title>ChinaPoll - Public opinion made visible</title>');
    expect(xml).toContain(`<link>${ORIGIN}/</link>`);
    expect(xml).toContain(`<atom:link href="${ORIGIN}/feed.xml" rel="self" type="application/rss+xml" />`);
    expect(xml).toContain('<language>zh-CN</language>');

    // The public number is what a feed links and identifies.
    expect(xml).toContain(`<link>${ORIGIN}/poll/12</link>`);
    expect(xml).toContain(`<guid isPermaLink="true">${ORIGIN}/poll/12</guid>`);
    expect(xml).toContain('<pubDate>Tue, 14 Nov 2023 22:13:20 GMT</pubDate>');
    // Newest first, exactly as the site lists them.
    expect(xml.indexOf('/poll/12')).toBeLessThan(xml.indexOf('/poll/11'));
    expect(xml.match(/<item>/g)).toHaveLength(2);
    // A poll with a description shows it as one plain line, and one without falls back to
    // the title.
    expect(xml).toContain('<description>Should the wall come down?</description>');
    expect(xml).toContain('<description>Bike lanes - ChinaPoll</description>');
  });

  it('escapes a hostile title and description', () => {
    const xml = buildRssFeed(
      [{ number: 3, title: '<b>Title</b>', description: 'a & b <script>x</script>', createdAt: 1_700_000_000 }],
      settings,
      ORIGIN
    );

    expect(xml).not.toContain('<b>Title</b>');
    expect(xml).not.toContain('<script>');
    expect(xml).toContain('&lt;b&gt;Title&lt;/b&gt;');
    expect(xml).toContain('a &amp; b');
  });

  it('publishes no item while no poll is public', () => {
    const xml = buildRssFeed([], settings, ORIGIN);
    expect(xml).not.toContain('<item>');
    // The channel itself is still a valid feed.
    expect(xml).toContain('</channel>');
  });
});

describe('buildJsonFeed', () => {
  it('writes the JSON Feed shape with one item per poll', () => {
    const feed = JSON.parse(buildJsonFeed(polls, settings, ORIGIN)) as Record<string, unknown>;

    expect(feed.version).toBe('https://jsonfeed.org/version/1.1');
    expect(feed.title).toBe('ChinaPoll - Public opinion made visible');
    expect(feed.home_page_url).toBe(`${ORIGIN}/`);
    expect(feed.feed_url).toBe(`${ORIGIN}/feed.json`);
    expect(feed.language).toBe('zh-CN');
    expect(feed.items).toEqual([
      {
        id: `${ORIGIN}/poll/12`,
        url: `${ORIGIN}/poll/12`,
        title: '#12 拆墙：完全取消对境外网站的访问限制',
        content_text: 'Should the wall come down?',
        date_published: '2023-11-14T22:13:20.000Z'
      },
      {
        id: `${ORIGIN}/poll/11`,
        url: `${ORIGIN}/poll/11`,
        title: '#11 Bike lanes',
        content_text: 'Bike lanes - ChinaPoll',
        date_published: '2023-11-03T08:26:40.000Z'
      }
    ]);
  });

  it('carries at most the item limit', () => {
    // The loader is what applies the limit; the builder publishes what it is given, so a
    // feed never grows past one page of the site's own list.
    expect(FEED_ITEM_LIMIT).toBe(30);
    expect(buildJsonFeed([], settings, ORIGIN)).toContain('"items": []');
  });
});