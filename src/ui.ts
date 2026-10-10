import { ArrowBigDown, ArrowBigUp, CircleAlert, CircleCheck, Minus, Search, X, type IconNode } from 'lucide';
import { DEFAULT_LOCALE, getLocaleText } from './i18n';
import { getComments, type CommentsResponse, type PollSummary, type VoteOption } from './lib/poll';
import { getPublicSettings } from './config';

const voteButtonStyles: Record<VoteOption, { color: string; empty: string }> = {
  approve: { color: '#1fa36a', empty: '#e7f5ed' },
  neutral: { color: '#7a8798', empty: '#edf0f4' },
  oppose: { color: '#d95b5b', empty: '#faeaea' }
};

// Lucide icon nodes are inlined into SVG markup at build time; no icon library ships at runtime.
function iconMarkup(node: IconNode, cssClass: string): string {
  const children = node.map(([tag, attrs]) => {
    const attributes = Object.entries(attrs)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([name, value]) => ` ${name}="${value}"`)
      .join('');
    return `<${tag}${attributes} />`;
  }).join('');
  return `<svg class="${cssClass}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${children}</svg>`;
}

const voteIcons: Record<VoteOption, IconNode> = {
  approve: ArrowBigUp,
  neutral: Minus,
  oppose: ArrowBigDown
};

export function voteIconMarkup(option: VoteOption, cssClass: string): string {
  return iconMarkup(voteIcons[option], cssClass);
}

export function searchIconMarkup(cssClass: string): string {
  return iconMarkup(Search, cssClass);
}

export function closeIconMarkup(cssClass: string): string {
  return iconMarkup(X, cssClass);
}

const toastIcons: Record<'success' | 'error', IconNode> = {
  success: CircleCheck,
  error: CircleAlert
};

// Shared toast used by every page. Shows a Lucide icon instead of an emoji.
export function renderToast(): string {
  return '<div class="fixed top-5 left-1/2 z-10 flex max-w-[min(420px,calc(100vw-40px))] -translate-x-1/2 items-center gap-2 rounded-xl border border-border bg-panel px-[18px] py-3 text-ink shadow-card" data-toast role="status" aria-live="polite" hidden></div>';
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function showToast(message: string, kind: 'success' | 'error' = 'success'): void {
  const toast = document.querySelector<HTMLElement>('[data-toast]');
  if (!toast) return;
  if (toastTimer) clearTimeout(toastTimer);

  const iconClass = kind === 'error' ? 'h-4 w-4 shrink-0 text-[#d95b5b]' : 'h-4 w-4 shrink-0 text-[#1fa36a]';
  toast.innerHTML = `${iconMarkup(toastIcons[kind], iconClass)}<span>${escapeHtml(message)}</span>`;
  toast.hidden = false;
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 3500);
}

export function getPollsPerPage(): number {
  return getPublicSettings().polls_per_page;
}

export function getCommentsPerPage(): number {
  return getPublicSettings().comments_per_page;
}

export function t(key: string): string {
  return getLocaleText(DEFAULT_LOCALE, key);
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function getSiteName(): string {
  return getPublicSettings().site_name || t('appName');
}

export function renderHeader(activeRoute: string): string {
  return `
    <header class="flex items-center justify-between gap-4 py-4 pb-5 max-[700px]:flex-wrap max-[700px]:gap-3">
      <div class="flex flex-wrap items-center gap-x-7 gap-y-2 max-[700px]:gap-x-5">
        <a class="text-3xl font-extrabold leading-none text-primary hover:underline" href="/" data-route="/" aria-label="${escapeHtml(t('homeLinkLabel'))}">${escapeHtml(getSiteName())}</a>
        <nav class="flex flex-wrap items-center gap-[18px]">
          ${getNavigationMarkup(activeRoute)}
        </nav>
      </div>
      ${renderHeaderSearch()}
    </header>
  `;
}

function renderHeaderSearch(): string {
  const initialQuery = new URLSearchParams(window.location.search).get('q') ?? '';
  const isOpen = initialQuery !== '';
  const formStateClass = isOpen
    ? 'w-56 opacity-100 max-[700px]:w-full'
    : 'w-0 opacity-0 pointer-events-none';
  const toggleStateClass = isOpen
    ? 'w-0 overflow-hidden border-0 opacity-0 pointer-events-none'
    : 'w-9 opacity-100';

  return `
    <div class="flex flex-wrap items-center gap-2 max-[700px]:w-full" data-search-root data-search-open="${isOpen}">
      <button
        type="button"
        class="flex h-9 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border bg-panel text-muted transition-[width,opacity] duration-200 ease-out hover:border-primary hover:text-primary ${toggleStateClass}"
        data-search-toggle
        aria-expanded="${isOpen}"
        aria-controls="header-search-form"
        aria-label="${escapeHtml(t('search'))}"
        title="${escapeHtml(t('search'))}"
      >
        ${searchIconMarkup('h-4 w-4 shrink-0')}
      </button>
      <form
        class="flex items-center gap-2 overflow-hidden transition-[width,opacity] duration-200 ease-out max-[700px]:max-w-full ${formStateClass}"
        id="header-search-form"
        data-search-form
        role="search"
      >
        <input
          class="h-9 w-full min-w-0 rounded-full border border-border bg-panel px-4 text-sm text-ink outline-none focus:border-primary"
          data-search-input
          name="q"
          type="search"
          autocomplete="off"
          maxlength="100"
          value="${escapeHtml(initialQuery)}"
          placeholder="${escapeHtml(t('searchPlaceholder'))}"
          aria-label="${escapeHtml(t('searchPlaceholder'))}"
        >
        <button
          class="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border bg-panel text-muted transition-colors hover:border-primary hover:text-primary"
          data-search-close
          type="button"
          aria-label="${escapeHtml(t('searchClose'))}"
          title="${escapeHtml(t('searchClose'))}"
        >
          ${closeIconMarkup('h-4 w-4')}
        </button>
      </form>
      <p class="m-0 hidden basis-full text-xs text-muted" data-search-status role="status" aria-live="polite"></p>
    </div>
  `;
}

export function renderFooter(): string {
  const dataUrl = getPublicSettings().data_repository_url;

  return `
    <footer class="mt-9 flex flex-wrap items-center justify-center gap-3 text-center text-[0.9rem] text-muted">
      <span>Powered by <a class="font-bold text-primary hover:underline" href="https://github.com/qianhujia/chinapoll" target="_blank" rel="noopener noreferrer">${getSiteName()}</a></span>
      <a class="text-primary hover:underline" href="/submit/claim" data-route="/submit/claim">${t('claimProposalLink')}</a>
      ${dataUrl ? `<a class="text-primary hover:underline" href="${escapeHtml(dataUrl)}" target="_blank" rel="noopener noreferrer">${t('dataLink')}</a>` : ''}
    </footer>
  `;
}

export function renderPagination(page: number, totalPages: number, getPageUrl: (page: number) => string): string {
  if (totalPages <= 1) return '';

  return `
    <nav class="mt-5 flex items-center justify-center gap-4" aria-label="${t('pagination')}">
      ${page === 1
    ? `<span class="rounded-full px-4 py-2.5 text-muted" aria-disabled="true">${t('previousPage')}</span>`
    : `<a class="rounded-full px-4 py-2.5 text-ink no-underline hover:bg-primary-soft hover:no-underline" href="${getPageUrl(page - 1)}" data-route="${getPageUrl(page - 1)}">${t('previousPage')}</a>`}
      <span>${t('pageOf')} ${page} / ${totalPages}</span>
      ${page === totalPages
    ? `<span class="rounded-full px-4 py-2.5 text-muted" aria-disabled="true">${t('nextPage')}</span>`
    : `<a class="rounded-full px-4 py-2.5 text-ink no-underline hover:bg-primary-soft hover:no-underline" href="${getPageUrl(page + 1)}" data-route="${getPageUrl(page + 1)}">${t('nextPage')}</a>`}
    </nav>
  `;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character] ?? character);
}

export function renderCommentsContent(pollId: number, response: CommentsResponse): string {
  const totalPages = Math.ceil(response.total / response.pageSize);
  const comments = response.comments.length
    ? `<ul class="m-0 grid list-none gap-3.5 p-0">${response.comments.map(({ comment, createdAt }) => `
        <li class="border-b border-border py-3.5">
          <p class="mb-2 whitespace-pre-wrap [overflow-wrap:anywhere]">${escapeHtml(comment)}</p>
          <time class="text-xs text-muted" datetime="${escapeHtml(createdAt)}">${escapeHtml(createdAt)}</time>
        </li>
      `).join('')}</ul>`
    : `<p class="text-muted">${t('noComments')}</p>`;

  return `${comments}${renderPagination(response.page, totalPages, (page) => `/poll/${pollId}?commentsPage=${page}`)}`;
}

export async function updateComments(pollId: number, page: number, bindNavigation: () => void): Promise<void> {
  const content = document.querySelector('#comments-content');
  if (!content) return;

  try {
    const response = await getComments(pollId, page, getCommentsPerPage());
    content.innerHTML = renderCommentsContent(pollId, response);
    bindNavigation();
  } catch {
    content.textContent = t('commentsLoadFailed');
  }
}

export function getQueryPage(key: string): number {
  const page = Number(new URLSearchParams(window.location.search).get(key));
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

export function getQueryValue(key: string): string {
  return (new URLSearchParams(window.location.search).get(key) ?? '').trim().slice(0, 100);
}

export function renderModeBadge(mode: PollSummary['mode']): string {
  return `<span class="shrink-0 rounded-full bg-[#f1f3f5] px-[9px] py-[3px] text-xs leading-[1.5] font-light whitespace-nowrap text-muted">${mode === 'deadline' ? t('deadline') : t('evergreen')}</span>`;
}

function voteFillPath(percent: number): string {
  if (percent >= 100) return 'M0 0 H100 V100 H0 Z';
  const level = 100 - percent;
  return `M0 ${level} H100 V100 H0 Z`;
}

export function renderVoteButton(
  option: VoteOption,
  count: number,
  total: number,
  disabled: boolean,
  title: string,
  homePollId?: number
): string {
  const style = voteButtonStyles[option];
  const label = t(option);
  const percent = total > 0 ? count / total * 100 : 0;
  const homeAttributes = homePollId === undefined
    ? ''
    : `data-home-vote data-poll-id="${homePollId}"`;

  return `
    <button
      type="button"
      class="relative flex min-w-0 flex-1 flex-wrap cursor-pointer items-center justify-center gap-x-1 gap-y-0.5 border-r border-border px-1 py-2 text-xs text-ink transition-[filter] hover:enabled:brightness-95 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-primary last:border-r-0 disabled:cursor-not-allowed disabled:opacity-[0.65]"
      style="background:${style.empty}"
      data-option="${option}"
      aria-label="${label}: ${count}"
      title="${title}"
      ${homeAttributes}
      ${disabled ? 'disabled' : ''}
    >
      <svg class="pointer-events-none absolute inset-0 h-full w-full" data-vote-fill="${option}" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <path d="${count > 0 ? voteFillPath(percent) : ''}" fill="${style.color}"></path>
      </svg>
      ${homePollId === undefined
    ? `${voteIconMarkup(option, 'relative z-10 h-4 w-4 shrink-0')}<span class="relative z-10 whitespace-nowrap">${label}</span>`
    : voteIconMarkup(option, 'relative z-10 h-4 w-4 shrink-0')}
      <span class="choice-count relative z-10 shrink-0 tabular-nums" data-vote-count="${option}">${count}</span>
    </button>
  `;
}

export function updateVoteGroup(group: HTMLElement, counts: Record<VoteOption, number>): void {
  const total = counts.approve + counts.neutral + counts.oppose;
  for (const option of ['approve', 'neutral', 'oppose'] as const) {
    const button = group.querySelector<HTMLButtonElement>(`[data-option="${option}"]`);
    const countElement = button?.querySelector<HTMLElement>('[data-vote-count]');
    if (!button || !countElement) continue;

    const count = counts[option];
    const percent = total > 0 ? count / total * 100 : 0;
    const fillPath = button.querySelector<SVGPathElement>('[data-vote-fill] path');
    if (fillPath) fillPath.setAttribute('d', count > 0 ? voteFillPath(percent) : '');
    countElement.textContent = String(count);
    button.setAttribute('aria-label', `${t(option)}: ${count}`);
  }
}

export function getNavigationMarkup(activeRoute: string): string {
  const links = [
    { route: '/', label: t('home') },
    { route: '/about', label: t('about') },
    { route: '/submit', label: t('propose') }
  ];

  return links.map(({ route, label }) => `
    <a class="py-1 text-muted no-underline hover:text-primary ${activeRoute === route ? 'font-bold text-primary' : ''}" href="${route}" data-route="${route}">${label}</a>
  `).join('');
}
