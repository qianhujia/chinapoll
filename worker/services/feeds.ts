// RSS 2.0 and JSON Feed for the public poll list.
//
// Both carry the newest public polls in the order the site lists them, so a reader that
// subscribes sees what the home page shows. A feed is a view of published data only:
// pending polls are never included, and a poll's description is reduced to the same one
// plain line a meta description is (see `seoDescription`), because a feed reader prints it
// as text and may show none of the page around it.

import { PollMode, PollStatus } from '../enums';
import { escapeHtml } from './html';
import { resolveSeoDescription, seoDescription } from '../../shared/seo';

// How many polls a feed carries: a window on the newest content, not an archive of the
// site, so a reader that wants older polls follows the site's own paging.
export const FEED_ITEM_LIMIT = 30;

export interface FeedPoll {
  /** The public number, which is what the feed links and identifies. */
  number: number;
  title: string;
  description: string | null;
  /** Unix seconds the poll was submitted. */
  createdAt: number;
}

export interface FeedSettings {
  site_name: string;
  site_slogan: string;
  default_locale: string;
  /** The home page's description template, used for the channel description. */
  home_description?: string;
}

// The newest public polls, newest first. The predicate matches the poll list and the
// sitemap: a deadline or evergreen poll that is open, closed, or archived.
export async function loadFeedPolls(db: D1Database, limit = FEED_ITEM_LIMIT): Promise<FeedPoll[]> {
  const result = await db.prepare(
    `SELECT number, title, description, created_at FROM polls
     WHERE mode IN (?, ?) AND status IN (?, ?, ?)
     ORDER BY created_at DESC, id DESC LIMIT ?`
  ).bind(
    PollMode.Deadline, PollMode.Evergreen,
    PollStatus.Open, PollStatus.Closed, PollStatus.Archived,
    limit
  ).all<{ number: number; title: string; description: string | null; created_at: number }>();

  return (result.results ?? []).map((row) => ({
    number: Number(row.number),
    title: String(row.title ?? ''),
    description: row.description ?? null,
    createdAt: Number(row.created_at ?? 0)
  }));
}

// The feed's own name: the site and its slogan, or just the site while it has none.
export function feedTitle(settings: FeedSettings): string {
  return settings.site_slogan ? `${settings.site_name} - ${settings.site_slogan}` : settings.site_name;
}

// The channel description, resolved the way the home page resolves its own, so a reader
// that lists the feed reads the same wording a search engine does.
export function feedDescription(settings: FeedSettings): string {
  return resolveSeoDescription(settings.home_description, {
    site_name: settings.site_name,
    slogan: settings.site_slogan
  }) || settings.site_slogan;
}

// What one item says about its poll: the poll's own description, or its title when the
// description carries nothing once its markup is gone.
function itemSummary(poll: FeedPoll, settings: FeedSettings): string {
  return seoDescription(poll.description) || `${poll.title} - ${settings.site_name}`;
}

export function buildRssFeed(
  polls: ReadonlyArray<FeedPoll>,
  settings: FeedSettings,
  origin: string
): string {
  const items = polls.map((poll) => {
    const url = `${origin}/poll/${poll.number}`;
    // RSS dates are RFC 822 strings; a feed reader parses them, so the ISO form the JSON
    // feed uses would be ignored here.
    return `    <item>
      <title>${escapeHtml(`#${poll.number} ${poll.title}`)}</title>
      <link>${escapeHtml(url)}</link>
      <guid isPermaLink="true">${escapeHtml(url)}</guid>
      <pubDate>${new Date(poll.createdAt * 1000).toUTCString()}</pubDate>
      <description>${escapeHtml(itemSummary(poll, settings))}</description>
    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeHtml(feedTitle(settings))}</title>
    <link>${escapeHtml(`${origin}/`)}</link>
    <description>${escapeHtml(feedDescription(settings))}</description>
    <language>${escapeHtml(settings.default_locale)}</language>
    <atom:link href="${escapeHtml(`${origin}/feed.xml`)}" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>
`;
}

export function buildJsonFeed(
  polls: ReadonlyArray<FeedPoll>,
  settings: FeedSettings,
  origin: string
): string {
  return `${JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1',
    title: feedTitle(settings),
    home_page_url: `${origin}/`,
    feed_url: `${origin}/feed.json`,
    description: feedDescription(settings),
    language: settings.default_locale,
    items: polls.map((poll) => ({
      id: `${origin}/poll/${poll.number}`,
      url: `${origin}/poll/${poll.number}`,
      title: `#${poll.number} ${poll.title}`,
      content_text: itemSummary(poll, settings),
      date_published: new Date(poll.createdAt * 1000).toISOString()
    }))
  }, null, 2)}\n`;
}