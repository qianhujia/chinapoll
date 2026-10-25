// Server-side rendering for the public Worker.
//
// The single-page app mounts into the empty `<div id="app">` in the document
// shell. This module fills that element with crawlable HTML for the routes
// search engines care about (the poll list, a poll page, and the about page), so
// the very first response already contains the site's headings, poll titles,
// internal links, and copy instead of relying on the client bundle. The client
// bundle re-renders the same container when it boots, so this is a fast,
// indexable first paint rather than a second source of truth.
//
// Every interpolated value is escaped (see ./html). The markup deliberately
// reuses the SPA's utility classes so the server-rendered paint and the client
// paint look alike.

import { PollMode, PollStatus, PollType } from '../enums';
import { ABOUT_SECTIONS } from '../../shared/about';
import { localizedTopicName, type TopicLocale } from '../../shared/categories';
import en from '../../public/i18n/en.json';
import zh from '../../public/i18n/zh.json';
import zhTW from '../../public/i18n/zh-TW.json';
import { escapeHtml } from './html';
import { loadPollNeighbors, type PollNeighbor } from './pollNav';

export type Translate = (key: string) => string;

export type Locale = 'en' | 'zh-CN' | 'zh-TW';

// The source repository credited in the footer, matching the SPA footer.
const SOURCE_REPOSITORY_URL = 'https://github.com/qianhujia/chinapoll';

// The Lucide plus icon that prefixes the "New Poll" call to action, inlined so
// the server-rendered hero matches the icon the SPA draws.
const PLUS_ICON = '<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14" /><path d="M12 5v14" /></svg>';

// The same three dictionaries the SPA ships, so the server-rendered first paint
// is in the site's default language instead of always English.
const DICTIONARIES: Record<Locale, Record<string, string>> = {
  en,
  'zh-CN': zh,
  'zh-TW': zhTW
};

const ENGLISH: Record<string, string> = en;

// The locale setting is stored in a few spellings; normalize them to the three
// dictionaries above (mirrors src/i18n.ts resolveLocale).
export function normalizeLocale(value: string | null | undefined): Locale {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized === 'zh-tw' || normalized === 'zh_tw' || normalized === 'zh-hant') return 'zh-TW';
  if (normalized === 'zh' || normalized === 'zh-cn' || normalized === 'zh_cn' || normalized === 'cn') return 'zh-CN';
  return 'en';
}

// Labels for one locale. A key that is missing from that dictionary falls back
// to English and then to the key itself, so a translation gap never renders an
// empty string.
export function translatorFor(locale: string | null | undefined): Translate {
  const dictionary = DICTIONARIES[normalizeLocale(locale)];
  return (key) => dictionary[key] ?? ENGLISH[key] ?? key;
}

// The raw dictionary for one locale, exactly as the SPA fetches it from
// `/i18n/<locale>.json`. The bootstrap island ships it inside the document so the
// client does not need that extra request (see ./bootstrap).
export function dictionaryFor(locale: string | null | undefined): Record<string, string> {
  return DICTIONARIES[normalizeLocale(locale)];
}

// English labels, used as the default when a caller has no locale at hand.
export const serverTranslate: Translate = translatorFor('en');

export interface SsrSettings {
  site_name: string;
  site_slogan: string;
  default_locale: string;
  hero_title: string;
  hero_subtitle: string;
  data_repository_url: string;
  polls_per_page: number;
  /** Optional base64 data URI of the configured header logo. */
  logo?: string;
}

export interface SsrTopic {
  slug: string;
  name: string;
  count: number;
}

export interface SsrPollCard {
  id: number;
  /** The public number a visitor sees; the primary key stays internal. */
  number: number;
  title: string;
  mode: PollMode;
  pollType: number;
  topic: { slug: string; name: string } | null;
}

export interface SsrPollDetail extends SsrPollCard {
  description: string | null;
  status: PollStatus;
  options: ReadonlyArray<{ label: string }>;
  /** The older/newer public poll, for the detail page's navigation links. */
  prev: PollNeighbor | null;
  next: PollNeighbor | null;
}

// The document shell contains this empty container; it is the SPA mount point.
const APP_PLACEHOLDER = /<div id="app">\s*<\/div>/;

// Replaces the empty SPA mount point with server-rendered markup. A shell that
// does not contain the expected container is returned unchanged.
export function injectAppBody(html: string, body: string): string {
  if (!body || !APP_PLACEHOLDER.test(html)) return html;
  return html.replace(APP_PLACEHOLDER, `<div id="app">${body}</div>`);
}

// Sets the document language to the site's default locale so crawlers and
// assistive technology see the right lang attribute before the client runs.
export function applyHtmlLang(html: string, defaultLocale: string): string {
  return html.replace(/<html lang="[^"]*"/, `<html lang="${normalizeLocale(defaultLocale)}"`);
}

function displayName(topic: { slug: string; name: string }, settings: SsrSettings): string {
  const locale = (settings.default_locale ?? 'en') as TopicLocale;
  return localizedTopicName(topic.slug, topic.name, locale);
}

function modeLabel(mode: PollMode, t: Translate): string {
  return mode === PollMode.Deadline ? t('deadline') : t('evergreen');
}

function pollTypeLabel(pollType: number, t: Translate): string {
  if (pollType === PollType.Verdict) return t('pollTypeVerdict');
  if (pollType === PollType.MultiChoice) return t('pollTypeMultiChoice');
  return t('pollTypeSingleChoice');
}

function badge(label: string): string {
  return `<span class="shrink-0 rounded-full bg-[#f1f3f5] px-[9px] py-[3px] text-xs leading-[1.5] font-light whitespace-nowrap text-muted">${escapeHtml(label)}</span>`;
}

function topicBadge(topic: { slug: string; name: string }, settings: SsrSettings): string {
  const href = `/topic/${topic.slug}`;
  return `<a class="shrink-0 rounded-full bg-[#eef3fb] px-2 py-0.5 text-xs text-muted no-underline hover:text-primary" href="${escapeHtml(href)}" data-route="${escapeHtml(href)}" data-poll-topic>${escapeHtml(displayName(topic, settings))}</a>`;
}

function renderHeader(settings: SsrSettings, t: Translate, activeRoute: string): string {
  const links = [
    { route: '/', label: t('home') },
    { route: '/about', label: t('about') },
    { route: '/submit', label: t('propose') }
  ];

  const nav = links.map(({ route, label }) => `
          <a class="py-1 text-muted no-underline hover:text-primary ${activeRoute === route ? 'font-bold text-primary' : ''}" href="${route}" data-route="${route}">${escapeHtml(label)}</a>`).join('');

  // A configured logo replaces the wordmark; without one the site name is shown
  // as text, so the header never renders empty.
  const brand = settings.logo
    ? `<img class="h-9 w-auto" src="${escapeHtml(settings.logo)}" alt="${escapeHtml(settings.site_name)}">`
    : `<span class="text-3xl font-extrabold leading-none text-primary">${escapeHtml(settings.site_name)}</span>`;

  return `    <header class="flex items-center justify-between gap-4 py-4 pb-5 max-[700px]:flex-wrap max-[700px]:gap-3">
      <div class="flex flex-wrap items-center gap-x-7 gap-y-2 max-[700px]:gap-x-5">
        <a class="flex items-center" href="/" data-route="/" aria-label="${escapeHtml(t('homeLinkLabel'))}">${brand}</a>
        <nav class="flex flex-wrap items-center gap-x-6 gap-y-2 max-[700px]:gap-x-5" aria-label="${escapeHtml(t('home'))}">${nav}
        </nav>
      </div>
    </header>`;
}

function renderFooter(settings: SsrSettings, t: Translate): string {
  const dataUrl = settings.data_repository_url;
  // Mirrors the SPA footer: the credit names the site inside a link to the
  // source repository.
  const siteLink = `<a class="font-bold text-primary" href="${SOURCE_REPOSITORY_URL}" target="_blank" rel="noopener noreferrer">${escapeHtml(settings.site_name)}</a>`;
  // A translation that omits the placeholder still keeps the site link.
  const credit = t('poweredBy');
  const creditHtml = credit.includes('{name}') ? credit.replace('{name}', siteLink) : `${credit} ${siteLink}`;

  return `    <footer class="mt-9 flex flex-wrap items-center justify-center gap-3 text-center text-[0.9rem] text-muted">
      <span>${creditHtml}</span>
      ${dataUrl ? `<a class="text-primary" href="${escapeHtml(dataUrl)}" rel="noopener noreferrer">${escapeHtml(t('dataLink'))}</a>` : ''}
    </footer>`;
}

function renderTopicChips(
  topics: ReadonlyArray<SsrTopic>,
  total: number,
  activeTopic: string,
  settings: SsrSettings,
  t: Translate
): string {
  if (topics.length === 0) return '';

  const chip = (href: string, label: string, count: number, active: boolean): string => `
        <a class="rounded-full border px-3 py-1.5 text-sm no-underline hover:border-primary hover:text-primary ${active ? 'border-primary font-bold text-primary' : 'border-border bg-panel text-ink'}" href="${escapeHtml(href)}" data-route="${escapeHtml(href)}">${escapeHtml(label)} <span class="tabular-nums text-xs">${count}</span></a>`;

  const items = topics.map((topic) => chip(
    `/topic/${topic.slug}`,
    displayName(topic, settings),
    topic.count,
    activeTopic === topic.slug
  )).join('');

  return `      <nav class="flex flex-wrap items-center gap-2" aria-label="${escapeHtml(t('categoryLabel'))}">${chip('/', t('categoryAll'), total, !activeTopic)}${items}
      </nav>`;
}

function renderPollRow(poll: SsrPollCard, settings: SsrSettings, t: Translate): string {
  // The public number is what the site publishes and what a crawler should index;
  // the primary key only identifies the row internally.
  const href = `/poll/${poll.number}`;
  const topic = poll.topic ? topicBadge(poll.topic, settings) : '';
  const typeLabel = pollTypeLabel(poll.pollType, t);
  return `
        <article class="grid grid-cols-[minmax(0,1fr)_minmax(190px,240px)] items-center gap-x-8 border-b border-border py-[22px] max-[700px]:grid-cols-1 max-[700px]:gap-y-3" data-poll-row="${poll.id}">
          <div class="col-start-1 flex flex-wrap items-center gap-2">
            <span class="shrink-0 font-bold tabular-nums text-muted">#${poll.number}</span>
            <h2 class="m-0 flex-[1_1_auto] text-[1.15rem] leading-[1.5]"><a class="text-inherit no-underline hover:text-primary" href="${href}" data-route="${href}">${escapeHtml(poll.title)}</a></h2>
            ${badge(modeLabel(poll.mode, t))}
            ${badge(typeLabel)}
            ${topic}
          </div>
          <div class="col-start-2 row-start-1 flex items-center justify-center gap-5 max-[700px]:col-start-1">
            <a class="shrink-0 whitespace-nowrap rounded-full border border-border bg-panel px-3 py-1.5 text-xs text-ink no-underline hover:border-primary hover:text-primary" href="${href}" data-route="${href}">${escapeHtml(t('vote'))}</a>
          </div>
        </article>`;
}

function renderPagination(page: number, totalPages: number, getPageUrl: (page: number) => string, t: Translate): string {
  if (totalPages <= 1) return '';

  return `
      <nav class="mt-5 flex items-center justify-center gap-4" aria-label="${escapeHtml(t('pagination'))}">
        ${page === 1
          ? `<span class="rounded-full px-4 py-2.5 text-muted" aria-disabled="true">${escapeHtml(t('previousPage'))}</span>`
          : `<a class="rounded-full px-4 py-2.5 text-ink no-underline hover:bg-primary-soft" href="${escapeHtml(getPageUrl(page - 1))}" data-route="${escapeHtml(getPageUrl(page - 1))}">${escapeHtml(t('previousPage'))}</a>`}
        <span>${escapeHtml(t('pageOf'))} ${page} / ${totalPages}</span>
        ${page === totalPages
          ? `<span class="rounded-full px-4 py-2.5 text-muted" aria-disabled="true">${escapeHtml(t('nextPage'))}</span>`
          : `<a class="rounded-full px-4 py-2.5 text-ink no-underline hover:bg-primary-soft" href="${escapeHtml(getPageUrl(page + 1))}" data-route="${escapeHtml(getPageUrl(page + 1))}">${escapeHtml(t('nextPage'))}</a>`}
      </nav>`;
}

export interface HomeBodyInput {
  settings: SsrSettings;
  topics: ReadonlyArray<SsrTopic>;
  topicTotal: number;
  polls: ReadonlyArray<SsrPollCard>;
  page: number;
  totalPages: number;
  query: string;
  activeTopic: string;
  /** Site-wide totals shown in the hero statistics. */
  totalPolls: number;
  totalVotes: number;
  /** Whether the hero (with its call to action and statistics) is shown. */
  showHero: boolean;
}

// The home page, the polls list, and a topic page share one server-rendered
// shape: header, hero, topic chips, the poll list, and paging.
export function renderHomeBody(input: HomeBodyInput, t: Translate = serverTranslate): string {
  const { settings, topics, topicTotal, polls, page, totalPages, query, activeTopic, totalPolls, totalVotes, showHero } = input;

  const list = polls.length
    ? polls.map((poll) => renderPollRow(poll, settings, t)).join('')
    : `
          <p class="py-6 text-center text-muted">${escapeHtml(query ? t('searchNoResults') : t('noPolls'))}</p>`;

  const searchNote = query
    ? `
        <div class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-panel px-4 py-3 text-sm">
          <span class="text-muted">${escapeHtml(t('searchResultsFor'))}: <strong class="text-ink">${escapeHtml(query)}</strong></span>
          <a class="text-primary" href="/" data-route="/">${escapeHtml(t('searchClear'))}</a>
        </div>`
    : '';

  const getPageUrl = (target: number): string => {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (activeTopic) params.set('topic', activeTopic);
    params.set('page', String(target));
    return `/?${params.toString()}`;
  };

  // The hero carries the call to action and the site-wide statistics. It is
  // shown only on the first page with no search or topic filter, matching the
  // SPA, so a filtered or paged listing goes straight to the polls.
  const hero = showHero ? `
    <section class="px-5 pt-10 pb-12 max-[700px]:pt-6 max-[700px]:pb-8">
      <div class="mx-auto flex max-w-[var(--page-width)] flex-col items-center text-center">
        <h1 class="m-0 max-w-[22ch] text-[clamp(1.875rem,4vw,2.75rem)] leading-[1.15] font-extrabold tracking-[-0.02em] text-balance max-[700px]:max-w-none">${escapeHtml(settings.hero_title || settings.site_slogan)}</h1>
        <p class="m-0 mt-4 max-w-2xl text-[clamp(0.95rem,1.8vw,1.1rem)] leading-[1.5] text-muted">${escapeHtml(settings.hero_subtitle || settings.site_slogan)}</p>
        <div class="mt-6 flex flex-wrap items-center justify-center gap-3">
          <a class="inline-flex items-center gap-2 rounded-lg bg-primary px-6 py-2.5 text-sm text-white transition-all hover:opacity-90" href="/submit" data-route="/submit">${PLUS_ICON}${escapeHtml(t('ctaSubmitPolls'))}</a>
          <a class="rounded-lg border border-border bg-panel px-6 py-2.5 text-sm text-ink transition-colors hover:border-primary hover:text-primary" href="/about" data-route="/about">${escapeHtml(t('ctaAnonymousRules'))}</a>
        </div>

        <dl class="m-0 mt-12 flex flex-wrap items-start justify-center gap-x-16 gap-y-8 max-[700px]:mt-8 max-[700px]:gap-x-10">
          <div class="flex min-w-[110px] flex-col items-center gap-2">
            <dd class="order-1 m-0 text-[clamp(2rem,4vw,2.75rem)] leading-none tracking-[-0.02em] tabular-nums">${totalPolls}</dd>
            <dt class="order-2 text-xs font-normal text-muted">${escapeHtml(t('totalPolls'))}</dt>
          </div>
          <div class="flex min-w-[110px] flex-col items-center gap-2">
            <dd class="order-1 m-0 text-[clamp(2rem,4vw,2.75rem)] leading-none tracking-[-0.02em] tabular-nums">${topicTotal}</dd>
            <dt class="order-2 text-xs font-normal text-muted">${escapeHtml(t('openPolls'))}</dt>
          </div>
          <div class="flex min-w-[110px] flex-col items-center gap-2">
            <dd class="order-1 m-0 text-[clamp(2rem,4vw,2.75rem)] leading-none tracking-[-0.02em] tabular-nums" data-total-votes>${totalVotes}</dd>
            <dt class="order-2 text-xs font-normal text-muted">${escapeHtml(t('totalVotesCount'))}</dt>
          </div>
        </dl>
      </div>
    </section>` : '';

  return `    <div class="mx-auto max-w-[var(--page-width)] px-5 pt-6">
${renderHeader(settings, t, '/')}
    </div>
${hero}
    <div class="mx-auto max-w-[var(--page-width)] px-5 pt-6 pb-16">
      <main class="grid gap-5">${searchNote}
${renderTopicChips(topics, topicTotal, activeTopic, settings, t)}
        <section class="border-t border-border">${list}
        </section>
${renderPagination(page, totalPages, getPageUrl, t)}
      </main>

${renderFooter(settings, t)}
    </div>`;
}

// The previous/next links for a poll page, each carrying the poll number and
// title. The whole block is omitted when the poll sits at both ends of the list,
// so a poll with no neighbors adds no empty navigation.
function pollNavMarkup(poll: SsrPollDetail, t: Translate): string {
  if (!poll.prev && !poll.next) return '';
  const link = (neighbor: PollNeighbor, label: string, align: string): string => {
    const href = `/poll/${neighbor.number}`;
    return `
          <a class="flex min-w-0 max-w-full flex-col gap-0.5 rounded-[14px] border border-border bg-[#f9fbff] px-3.5 py-2.5 no-underline hover:border-primary sm:max-w-[48%] ${align}" href="${href}" data-route="${href}">
            <span class="text-xs text-muted">${escapeHtml(label)}</span>
            <span class="truncate text-sm text-ink">${escapeHtml(`#${neighbor.number} ${neighbor.title}`)}</span>
          </a>`;
  };
  const prev = poll.prev ? link(poll.prev, `← ${t('prevPoll')}`, '') : '';
  const next = poll.next ? link(poll.next, `${t('nextPoll')} →`, 'ml-auto items-end text-right') : '';
  return `
        <nav class="flex flex-wrap items-stretch justify-between gap-3" aria-label="${escapeHtml(t('pollNavLabel'))}">${prev}${next}
        </nav>`;
}

// A single poll page: title, description, badges, and the option labels. The
// interactive ballot and results are added by the client bundle.
export function renderPollBody(poll: SsrPollDetail, settings: SsrSettings, t: Translate = serverTranslate): string {
  const topic = poll.topic ? topicBadge(poll.topic, settings) : '';
  const options = poll.options.length
    ? `
          <ul class="m-0 grid list-none gap-2 p-0">${poll.options.map((option) => `
            <li class="rounded-[14px] border border-border bg-[#f9fbff] px-3.5 py-2.5">${escapeHtml(option.label)}</li>`).join('')}
          </ul>`
    : '';

  return `    <div class="mx-auto max-w-[var(--page-width)] px-5 pt-6 pb-16">
${renderHeader(settings, t, '/')}
      <main class="grid gap-5">
        <article class="rounded-[22px] border border-border bg-panel p-6 shadow-card">
          <div class="flex flex-wrap items-center justify-center gap-2 text-center">
            ${badge(modeLabel(poll.mode, t))}
            ${badge(pollTypeLabel(poll.pollType, t))}
            ${topic}
          </div>
          <h1 class="mt-3 mb-2 text-center text-2xl font-bold">#${poll.number} ${escapeHtml(poll.title)}</h1>
          ${poll.description ? `<p class="mx-auto mb-0 max-w-2xl text-center text-ink line-clamp-2">${escapeHtml(poll.description)}</p>` : ''}
          <h2 class="mt-6 mb-2 text-lg font-bold">${escapeHtml(t('optionsLabel'))}</h2>
${options}
        </article>${pollNavMarkup(poll, t)}
      </main>

${renderFooter(settings, t)}
    </div>`;
}

// The static about page, so its copy is part of the first response.
export function renderAboutBody(settings: SsrSettings, t: Translate = serverTranslate): string {
  const points = ['aboutPointOne', 'aboutPointTwo', 'aboutPointThree']
    .map((key) => `
            <li>${escapeHtml(t(key))}</li>`).join('');
  // The detail sections come from the shared ABOUT_SECTIONS list, so the
  // server-rendered copy stays identical to the one the client bundle renders.
  const sections = ABOUT_SECTIONS.map((section) => `
        <section class="rounded-[22px] border border-border bg-panel p-6 shadow-card">
          <h2 class="mt-0 mb-3 text-xl font-bold">${escapeHtml(t(section.title))}</h2>
          <ul class="m-0 list-disc space-y-2 pl-6 text-muted">${section.points.map((key) => `
            <li>${escapeHtml(t(key))}</li>`).join('')}
          </ul>
        </section>`).join('');

  return `    <div class="mx-auto max-w-[var(--page-width)] px-5 pt-6 pb-16">
${renderHeader(settings, t, '/about')}
      <main class="grid gap-5">
        <section class="rounded-[22px] border border-border bg-panel p-6 shadow-card">
          <h1 class="mb-3 text-2xl font-bold">${escapeHtml(t('aboutTitle'))}</h1>
          <p class="text-muted">${escapeHtml(t('aboutBody'))}</p>
          <ul class="list-disc space-y-2 pl-6">${points}
          </ul>
          <p class="mt-4 mb-0 text-sm text-muted">${escapeHtml(t('aiPrivacyNote'))}</p>
        </section>${sections}
      </main>

${renderFooter(settings, t)}
    </div>`;
}

// --- Data loading -----------------------------------------------------------

interface HomePollRow {
  id: number;
  number: number;
  title: string;
  mode: number;
  poll_type: number;
  topic_slug: string | null;
  topic_name: string | null;
}

interface PollDetailRow extends HomePollRow {
  description: string | null;
  status: number;
  created_at: number;
}

// Escapes the LIKE wildcards so a search term is matched literally.
function escapeLike(query: string): string {
  return query.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export interface HomeSsrData {
  polls: SsrPollCard[];
  page: number;
  totalPages: number;
  topics: SsrTopic[];
  topicTotal: number;
  /** Every open poll, matching the API's `totalPolls` and `topicTotal`. */
  totalPolls: number;
  /** Site-wide vote total, matching the API's `totalVotes`. */
  totalVotes: number;
}

// The poll list for the home, polls, and topic routes. It mirrors the ordering
// and filters of GET /api/polls so the server-rendered first paint matches what
// the client fetches a moment later: open polls, newest first, optional search
// and topic filter, one page at a time.
export async function loadHomeSsrData(
  db: D1Database,
  options: { pageSize: number; page: number; query: string; topicSlug: string }
): Promise<HomeSsrData> {
  const { pageSize, query, topicSlug } = options;
  const searchClause = query
    ? " AND (title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')"
    : '';
  const searchBinds = query ? [`%${escapeLike(query)}%`, `%${escapeLike(query)}%`] : [];
  const topicClause = topicSlug
    ? ' AND topic_id = (SELECT id FROM topics WHERE slug = ? AND enabled = 1)'
    : '';
  const topicBinds = topicSlug ? [topicSlug] : [];

  const countRow = await db.prepare(
    `SELECT COUNT(*) AS total FROM polls WHERE status = ? AND mode IN (?, ?)${searchClause}${topicClause}`
  ).bind(PollStatus.Open, PollMode.Deadline, PollMode.Evergreen, ...searchBinds, ...topicBinds)
    .first<{ total: number }>();

  const total = Number(countRow?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, options.page), totalPages);
  const offset = (page - 1) * pageSize;

  const rows = await db.prepare(
    `WITH page AS (
       SELECT id FROM polls
       WHERE status = ? AND mode IN (?, ?)${searchClause}${topicClause}
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
     )
     SELECT p.id, p.number, p.title, p.mode, p.poll_type,
       t.slug AS topic_slug, t.name AS topic_name
     FROM page JOIN polls p ON p.id = page.id
     LEFT JOIN topics t ON t.id = p.topic_id
     ORDER BY p.created_at DESC, p.id DESC`
  ).bind(
    PollStatus.Open, PollMode.Deadline, PollMode.Evergreen,
    ...searchBinds, ...topicBinds, pageSize, offset
  ).all<HomePollRow>();

  const { topics, total: topicTotal } = await loadSsrTopics(db);

  // The two hero statistics that do not depend on the current filter: the open
  // polls site-wide, and the site-wide vote total read from the latest snapshot
  // per poll (mirrors GET /api/polls). Only open polls are counted, so the
  // `Polls` statistic matches the `Open polls` total beside it.
  const [allPollsRow, voteTotalRow] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS total FROM polls WHERE status = ? AND mode IN (?, ?)')
      .bind(PollStatus.Open, PollMode.Deadline, PollMode.Evergreen).first<{ total: number }>(),
    db.prepare(
      `SELECT COALESCE(SUM(s.ballots), 0) AS total
       FROM stats_snapshots s
       JOIN (SELECT poll_id, MAX(ts_hour) AS ts_hour FROM stats_snapshots GROUP BY poll_id) latest
         ON latest.poll_id = s.poll_id AND latest.ts_hour = s.ts_hour`
    ).first<{ total: number }>()
  ]);

  const polls: SsrPollCard[] = (rows.results ?? []).map((row) => ({
    id: Number(row.id),
    number: Number(row.number),
    title: row.title,
    mode: Number(row.mode) as PollMode,
    pollType: Number(row.poll_type ?? PollType.SingleChoice),
    topic: row.topic_slug && row.topic_name
      ? { slug: row.topic_slug, name: row.topic_name }
      : null
  }));

  return {
    polls,
    page,
    totalPages,
    topics,
    topicTotal,
    totalPolls: Number(allPollsRow?.total ?? 0),
    totalVotes: Number(voteTotalRow?.total ?? 0)
  };
}

// The enabled topics with their open-poll counts, used for the chip row. This
// mirrors GET /api/topics.
export async function loadSsrTopics(db: D1Database): Promise<{ topics: SsrTopic[]; total: number }> {
  const rows = await db.prepare(
    `SELECT t.slug, t.name,
       (SELECT COUNT(*) FROM polls p
        WHERE p.topic_id = t.id AND p.status = ? AND p.mode IN (?, ?)) AS count
     FROM topics t
     WHERE t.enabled = 1
     ORDER BY t.position ASC, t.id ASC`
  ).bind(PollStatus.Open, PollMode.Deadline, PollMode.Evergreen)
    .all<{ slug: string; name: string; count: number }>();

  const totalRow = await db.prepare(
    'SELECT COUNT(*) AS total FROM polls WHERE status = ? AND mode IN (?, ?)'
  ).bind(PollStatus.Open, PollMode.Deadline, PollMode.Evergreen).first<{ total: number }>();

  return {
    topics: (rows.results ?? []).map((row) => ({
      slug: row.slug,
      name: row.name,
      count: Number(row.count ?? 0)
    })),
    total: Number(totalRow?.total ?? 0)
  };
}

// One poll with its option labels for the server-rendered poll page. Returns
// null for an id that is not a public poll, so the caller can fall back to the
// client-rendered not-found state.
export async function loadPollSsrData(db: D1Database, identifier: number): Promise<SsrPollDetail | null> {
  const visible = 'p.mode IN (?, ?) AND p.status IN (?, ?, ?)';
  const visibleBinds = [
    PollMode.Deadline, PollMode.Evergreen,
    PollStatus.Open, PollStatus.Closed, PollStatus.Archived
  ];
  const columns = `p.id, p.number, p.title, p.description, p.mode, p.poll_type, p.status, p.created_at,
            t.slug AS topic_slug, t.name AS topic_name`;
  const source = 'FROM polls p LEFT JOIN topics t ON t.id = p.topic_id';

  // The public number is tried first because that is the identifier the site
  // publishes. The primary key is still accepted, so a link that predates the
  // public number keeps resolving instead of turning into a 404.
  const row = await db.prepare(`SELECT ${columns} ${source} WHERE p.number = ? AND ${visible}`)
      .bind(identifier, ...visibleBinds).first<PollDetailRow>()
    ?? await db.prepare(`SELECT ${columns} ${source} WHERE p.id = ? AND ${visible}`)
      .bind(identifier, ...visibleBinds).first<PollDetailRow>();

  if (!row) return null;

  const [optionRows, neighbors] = await Promise.all([
    db.prepare(
      'SELECT label FROM poll_options WHERE poll_id = ? ORDER BY position ASC, id ASC'
    ).bind(Number(row.id)).all<{ label: string }>(),
    loadPollNeighbors(db, Number(row.id), Number(row.created_at))
  ]);

  return {
    id: Number(row.id),
    number: Number(row.number),
    title: row.title,
    description: row.description,
    mode: Number(row.mode) as PollMode,
    pollType: Number(row.poll_type ?? PollType.SingleChoice),
    status: Number(row.status) as PollStatus,
    topic: row.topic_slug && row.topic_name
      ? { slug: row.topic_slug, name: row.topic_name }
      : null,
    options: (optionRows.results ?? []).map((option) => ({ label: option.label })),
    prev: neighbors.prev,
    next: neighbors.next
  };
}

