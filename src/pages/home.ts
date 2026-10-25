import { getTopics, getPolls } from '../lib/poll';
import { getPublicSettings } from '../config';
import { localizedTopicName } from '../../shared/categories';
import {
  escapeHtml,
  getErrorMessage,
  getPollsPerPage,
  getQueryValue,
  renderFooter,
  renderHeader,
  renderModeBadge,
  renderPagination,
  renderPollTypeBadge,
  renderToast,
  t,
  plusIconMarkup,
  viewIconMarkup
} from '../ui';

// One row of the poll list. Every poll is rendered the same way: identity,
// badges, the ballot total (or the threshold notice), the view count, and a vote
// link to the poll page. The list page never votes in place, so no vote controls
// are built here.
export function renderPollRow({ poll, stats, views }: Awaited<ReturnType<typeof getPolls>>['polls'][number]): string {
  const pollType = poll.pollType ?? stats.pollType ?? 'single_choice';
  const locale = (getPublicSettings().default_locale ?? 'en') as 'en' | 'zh-CN' | 'zh-TW';
  // An untopicalized poll shows nothing.
  const topicBadge = poll.topic
    ? `<span class="shrink-0 rounded-full bg-[#eef3fb] px-2 py-0.5 text-xs text-muted" data-poll-topic>${escapeHtml(localizedTopicName(poll.topic.slug, poll.topic.name, locale))}</span>`
    : '';
  const resultsHidden = stats.hidden === true;
  // The threshold notice replaces the ballot total, never the link.
  const voteTotalLine = resultsHidden
    ? `<span class="shrink-0 whitespace-nowrap text-xs leading-[1.2] text-muted">${t('resultsHidden').replace('{n}', String(stats.threshold))}</span>`
    : `<span class="shrink-0 whitespace-nowrap text-xs leading-[1.2] text-muted">${stats.ballots} ${t('ballots')}</span>`;

  return `
    <article class="grid grid-cols-[minmax(0,1fr)_minmax(190px,240px)] items-center gap-x-8 border-b border-border py-[22px] max-[700px]:grid-cols-1 max-[700px]:gap-y-3" data-poll-row="${poll.id}">
      <div class="col-start-1 flex items-start justify-between gap-[18px]">
        <div class="flex flex-wrap items-center gap-2">
          <span class="shrink-0 font-bold tabular-nums text-muted">#${poll.number}</span>
          <h2 class="m-0 flex-[1_1_auto] text-[1.15rem] leading-[1.5]"><a class="text-inherit no-underline hover:text-primary focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary" href="/poll/${poll.number}" data-route="/poll/${poll.number}">${escapeHtml(poll.title)}</a></h2>
          ${renderModeBadge(poll.mode)}
          ${renderPollTypeBadge(pollType)}
          ${topicBadge}
        </div>
      </div>

      <div class="col-start-2 row-start-1 flex items-center justify-center gap-5 max-[700px]:col-start-1">
        ${voteTotalLine}
        ${views ? `<span class="inline-flex shrink-0 items-center gap-1 text-xs leading-[1.2] text-muted" title="${t('views')}">${viewIconMarkup('h-3.5 w-3.5')}${views.total}</span>` : ''}
        <a class="shrink-0 whitespace-nowrap rounded-full border border-border bg-panel px-3 py-1.5 text-xs text-ink no-underline hover:border-primary hover:text-primary max-[700px]:col-start-1" href="/poll/${poll.number}" data-route="/poll/${poll.number}">${t('vote')}</a>
      </div>
    </article>
  `;
}

// Number of topic chips shown before the expand toggle appears. The row stays
// short so a long list of topics does not push the polls below the fold.
export const TOPIC_CHIP_LIMIT = 5;

export interface TopicChip {
  slug: string;
  label: string;
  count: number;
}

export interface TopicChipLabels {
  all: string;
  expand: string;
  collapse: string;
}

function topicChipClass(active: boolean, extra = false): string {
  return 'rounded-full border px-3 py-1.5 text-sm no-underline '
    + (active
      ? 'border-primary bg-primary text-white'
      : 'border-border bg-panel text-ink hover:border-primary hover:text-primary')
    + (extra ? ' hidden' : '');
}

// The topic chip row. At most TOPIC_CHIP_LIMIT topics are shown; the rest stay
// in the document but hidden until the expand text reveals them. A topic that is
// currently filtered in is always shown, even when it sorts past the limit, so
// the active selection is never hidden.
export function renderTopicChips(
  topics: ReadonlyArray<TopicChip>,
  total: number,
  activeTopic: string,
  labels: TopicChipLabels
): string {
  if (topics.length === 0) return '';

  const chip = (href: string, label: string, count: number, active: boolean, extra = false): string =>
    `<a class="${topicChipClass(active, extra)}"${extra ? ' data-topic-extra' : ''} href="${href}" data-route="${href}">${escapeHtml(label)} <span class="tabular-nums text-xs">${count}</span></a>`;

  // Keep the filtered topic visible so the row never hides what is selected.
  const activeIndex = topics.findIndex((topic) => topic.slug === activeTopic);
  const limit = activeIndex >= TOPIC_CHIP_LIMIT ? activeIndex + 1 : TOPIC_CHIP_LIMIT;
  const visible = topics.slice(0, limit);
  const extra = topics.slice(limit);

  const chips = [
    chip('/', labels.all, total, activeTopic === ''),
    ...visible.map((topic) => chip(
      `/topic/${encodeURIComponent(topic.slug)}`,
      topic.label,
      topic.count,
      activeTopic === topic.slug
    )),
    ...extra.map((topic) => chip(
      `/topic/${encodeURIComponent(topic.slug)}`,
      topic.label,
      topic.count,
      false,
      true
    ))
  ].join('');

  // No toggle when every topic already fits on the row. The toggle is a real
  // button so it stays keyboard- and screen-reader-operable, but it is styled as
  // plain text rather than another chip.
  const toggle = extra.length === 0 ? '' : `
          <button type="button" class="cursor-pointer bg-transparent p-0 text-sm text-primary" data-action="toggle-topics" aria-expanded="false" data-expand-label="${escapeHtml(labels.expand)}" data-collapse-label="${escapeHtml(labels.collapse)}">${escapeHtml(labels.expand)}</button>`;

  return `
        <nav class="flex flex-wrap items-center gap-2" data-topic-chips>${chips}${toggle}
        </nav>`;
}

// Wires the expand toggle: it reveals the hidden chips and swaps its own label
// and aria-expanded state.
function bindTopicChips(app: HTMLElement): void {
  const toggle = app.querySelector<HTMLButtonElement>('[data-action="toggle-topics"]');
  if (!toggle) return;

  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.textContent = expanded
      ? (toggle.dataset.collapseLabel ?? '')
      : (toggle.dataset.expandLabel ?? '');
    app.querySelectorAll<HTMLElement>('[data-topic-extra]').forEach((chip) => {
      chip.classList.toggle('hidden', !expanded);
    });
  });
}

export async function mountHome(app: HTMLElement, page: number, bindNavigation: () => void, settings?: Record<string, any>, topicSlug?: string): Promise<void> {
  const pollsPerPage = getPollsPerPage();
  const searchQuery = getQueryValue('q');
  const categoryFilter = topicSlug ?? getQueryValue('category');
  let pollStats: Awaited<ReturnType<typeof getPolls>>['polls'];
  let topics: Awaited<ReturnType<typeof getTopics>> | null = null;
  let openPolls: number;
  let totalPolls: number;
  let totalVotes: number;
  try {
    const [response, topicData] = await Promise.all([
      getPolls(page, pollsPerPage, searchQuery, categoryFilter),
      getTopics().catch(() => null)
    ]);
    pollStats = response.polls;
    openPolls = response.total;
    totalPolls = response.totalPolls;
    totalVotes = response.totalVotes;
    topics = topicData;
  } catch (error) {
    app.innerHTML = `
      <div class="mx-auto max-w-[var(--page-width)] px-5 pt-6 pb-16">
        ${renderHeader('/')}
        <main class="grid gap-5"><p class="m-0 text-center text-muted">${t('pollsLoadFailed')} ${getErrorMessage(error)}</p></main>
        ${renderFooter()}
      </div>
    `;
    bindNavigation();
    return;
  }

  const totalPages = Math.max(1, Math.ceil(openPolls / pollsPerPage));
  const currentPage = Math.min(Math.max(1, page), totalPages);

  const heroTitle = settings?.hero_title || t('heroTitle');
  const heroSubtitle = settings?.hero_subtitle || t('heroBody');
  const heroBackgroundColor = settings?.hero_background_color || '';
  const hasHeroBackground = heroBackgroundColor !== '';
  const heroBackgroundStyle = hasHeroBackground ? `background: ${heroBackgroundColor};` : '';
  const heroTextClass = hasHeroBackground ? 'text-white' : 'text-ink';
  const heroSubtleClass = hasHeroBackground ? 'text-white/70' : 'text-muted';
  const primaryCtaClass = hasHeroBackground
    ? 'bg-white text-ink hover:bg-white/90'
    : 'bg-primary text-white hover:opacity-90';
  const secondaryCtaClass = hasHeroBackground
    ? 'border border-white/60 text-white hover:bg-white/10'
    : 'border border-border bg-panel text-ink hover:border-primary hover:text-primary';
  const openPollsCount = openPolls;
  // Show hero only on the first page with no search query and no topic filter.
  const showHero = currentPage === 1 && searchQuery === '' && categoryFilter === '';

  // The topic chip row lists the enabled topics with the number of open polls
  // each holds; "All" is selected when no topic is filtered. Only the first few
  // chips are shown until the visitor expands the row.
  const localeCode = (getPublicSettings().default_locale ?? 'en') as 'en' | 'zh-CN' | 'zh-TW';
  const chipRow = renderTopicChips(
    (topics?.topics ?? []).map((topic) => ({
      slug: topic.slug,
      label: topic.names[localeCode] ?? topic.name,
      count: topic.count
    })),
    topics?.total ?? 0,
    categoryFilter,
    { all: t('categoryAll'), expand: t('topicsExpand'), collapse: t('topicsCollapse') }
  );

  app.innerHTML = `
    <div class="mx-auto max-w-[var(--page-width)] px-5 pt-6">
      ${renderHeader('/')}
    </div>

    ${showHero ? `
    <section class="relative px-5 pt-10 pb-12 max-[700px]:pt-6 max-[700px]:pb-8 ${heroTextClass}" style="${heroBackgroundStyle}">
      <div class="mx-auto flex max-w-[var(--page-width)] flex-col items-center text-center">
        <h1 class="m-0 max-w-[22ch] text-[clamp(1.875rem,4vw,2.75rem)] leading-[1.15] font-extrabold tracking-[-0.02em] text-balance max-[700px]:max-w-none">${escapeHtml(heroTitle)}</h1>
        <p class="m-0 mt-4 max-w-2xl text-[clamp(0.95rem,1.8vw,1.1rem)] leading-[1.5] ${heroSubtleClass}">${escapeHtml(heroSubtitle)}</p>
        <div class="mt-6 flex flex-wrap items-center justify-center gap-3">
          <a class="inline-flex items-center gap-2 rounded-lg px-6 py-2.5 text-sm transition-all ${primaryCtaClass}" href="/submit" data-route="/submit">${plusIconMarkup('h-4 w-4')}${t('ctaSubmitPolls')}</a>
          <a class="rounded-lg px-6 py-2.5 text-sm transition-colors ${secondaryCtaClass}" href="/about" data-route="/about">${t('ctaAnonymousRules')}</a>
        </div>

        <dl class="m-0 mt-12 flex flex-wrap items-start justify-center gap-x-16 gap-y-8 max-[700px]:mt-8 max-[700px]:gap-x-10">
          <div class="flex min-w-[110px] flex-col items-center gap-2">
            <dd class="order-1 m-0 text-[clamp(2rem,4vw,2.75rem)] leading-none tracking-[-0.02em] tabular-nums">${totalPolls}</dd>
            <dt class="order-2 text-xs font-normal ${heroSubtleClass}">${t('totalPolls')}</dt>
          </div>
          <div class="flex min-w-[110px] flex-col items-center gap-2">
            <dd class="order-1 m-0 text-[clamp(2rem,4vw,2.75rem)] leading-none tracking-[-0.02em] tabular-nums">${openPollsCount}</dd>
            <dt class="order-2 text-xs font-normal ${heroSubtleClass}">${t('openPolls')}</dt>
          </div>
          <div class="flex min-w-[110px] flex-col items-center gap-2">
            <dd class="order-1 m-0 text-[clamp(2rem,4vw,2.75rem)] leading-none tracking-[-0.02em] tabular-nums" data-total-votes>${totalVotes}</dd>
            <dt class="order-2 text-xs font-normal ${heroSubtleClass}">${t('totalVotesCount')}</dt>
          </div>
        </dl>
      </div>
    </section>` : ''}

    <div class="mx-auto max-w-[var(--page-width)] px-5 pt-6 pb-16">
      <main class="grid gap-5">
        ${searchQuery
    ? `<div class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-panel px-4 py-3 text-sm">
            <span class="text-muted">${t('searchResultsFor')}: <strong class="text-ink">${escapeHtml(searchQuery)}</strong> · ${openPolls}</span>
            <a class="text-primary" href="/" data-route="/">${t('searchClear')}</a>
          </div>`
    : ''}
        ${chipRow}
        <section class="border-t border-border">
          ${pollStats.length === 0
    ? `<p class="py-6 text-center text-muted">${searchQuery ? t('searchNoResults') : t('noPolls')}</p>`
    : pollStats.map(renderPollRow).join('')}
        </section>
        ${renderPagination(currentPage, totalPages, (targetPage) => {
    // The topic filter and the search survive paging.
    const params = new URLSearchParams();
    if (searchQuery) params.set('q', searchQuery);
    if (categoryFilter) params.set('topic', categoryFilter);
    params.set('page', String(targetPage));
    return `/?${params}`;
  })}
      </main>

      ${renderToast()}
      ${renderFooter()}
    </div>
  `;

  bindNavigation();
  bindTopicChips(app);
}
