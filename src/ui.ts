import { CircleAlert, CircleCheck, EllipsisVertical, Eye, Plus, Search, X, type IconNode } from 'lucide';
import { DEFAULT_LOCALE, getLocaleText, resolveLocale } from './i18n';
import { getComments, hasCommentReportedLocally, type CommentsResponse, type PollSummary } from './lib/poll';
import { getCurrentUser } from './lib/session';
import { apiErrorMessage } from './lib/apiError';
import { getPublicSettings } from './config';

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

export function searchIconMarkup(cssClass: string): string {
  return iconMarkup(Search, cssClass);
}

export function closeIconMarkup(cssClass: string): string {
  return iconMarkup(X, cssClass);
}

// Eye icon used next to a poll's view count.
export function viewIconMarkup(cssClass: string): string {
  return iconMarkup(Eye, cssClass);
}

// Vertical three-dot icon used by a "more actions" menu button.
export function moreIconMarkup(cssClass: string): string {
  return iconMarkup(EllipsisVertical, cssClass);
}

// Plus icon used by the "New Poll" call to action on the home hero.
export function plusIconMarkup(cssClass: string): string {
  return iconMarkup(Plus, cssClass);
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

// The message to display for a failed request. Backend errors carry a stable
// code (see src/lib/apiError.ts) that is translated into the current language;
// anything that cannot be identified becomes one localized generic message, so
// raw exception text is never shown.
export function getErrorMessage(error: unknown): string {
  return apiErrorMessage(error);
}

export function getSiteName(): string {
  return getPublicSettings().site_name || t('appName');
}

// The header logo URL, or an empty string when no logo is configured. An uploaded
// image is served by the branding endpoint; a pasted URL points elsewhere.
export function getSiteLogo(): string {
  return getPublicSettings().logo;
}

// Applies the admin-configured favicon to the document. The value is the branding
// endpoint's URL for an uploaded icon or an https URL the admin pasted; without
// one the document shell keeps whatever icon the browser requests by default.
export function applyFavicon(): void {
  const favicon = getPublicSettings().favicon;
  if (!favicon) return;
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = favicon;
}

export function renderHeader(activeRoute: string): string {
  const siteName = escapeHtml(getSiteName());
  const logo = getSiteLogo();
  // A configured logo replaces the wordmark; without one the site name is shown
  // as text, so the header never renders empty.
  const brand = logo
    ? `<img class="h-9 w-auto" src="${escapeHtml(logo)}" alt="${siteName}">`
    : `<span class="text-3xl font-extrabold leading-none text-primary">${siteName}</span>`;

  return `
    <header class="flex items-center justify-between gap-4 py-4 pb-5 max-[700px]:flex-wrap max-[700px]:gap-3">
      <div class="flex flex-wrap items-center gap-x-7 gap-y-2 max-[700px]:gap-x-5">
        <a class="flex items-center" href="/" data-route="/" aria-label="${siteName}">${brand}</a>
        <nav class="flex flex-wrap items-center gap-[18px]">
          ${getNavigationMarkup(activeRoute)}
          ${renderHeaderSearch()}
        </nav>
      </div>
      <div class="flex flex-wrap items-center gap-2 max-[700px]:w-full">
        ${renderHeaderAuthActions(activeRoute)}
      </div>
    </header>
  `;
}

// Right-aligned account actions. Signed-out visitors see the log in link and the
// sign up button; signed-in visitors see their own account ("My") link instead.
function renderHeaderAuthActions(activeRoute: string): string {
  if (getCurrentUser() !== null) {
    const isActive = activeRoute === '/account';
    return `
      <a class="py-1 whitespace-nowrap text-muted no-underline hover:text-primary ${isActive ? 'font-bold text-primary' : ''}" href="/account" data-route="/account">${escapeHtml(t('account'))}</a>
    `;
  }

  // The "optional" badge makes clear that signing in is not required. It is
  // placed on the top-right corner of both the login link and the sign-up button.
  const badge = getPublicSettings().login_badge_enable
    ? `<span class="pointer-events-none absolute -top-2 -right-2 rounded-full bg-[#f1f3f5] px-[6px] py-[1px] text-[10px] leading-[1.5] font-light whitespace-nowrap text-muted">${escapeHtml(t('loginOptionalBadge'))}</span>`
    : '';

  return `
      <a class="relative py-1 whitespace-nowrap text-muted no-underline hover:text-primary" href="/login" data-route="/login">${escapeHtml(t('login'))}${badge}</a>
      <a class="relative whitespace-nowrap rounded-full border border-primary bg-primary px-4 py-2 text-white no-underline hover:bg-[#0f2f61] hover:no-underline" href="/register" data-route="/register">${escapeHtml(t('register'))}${badge}</a>
  `;
}

function renderHeaderSearch(): string {
  const initialQuery = new URLSearchParams(window.location.search).get('q') ?? '';
  const isOpen = initialQuery !== '';
  const formStateClass = isOpen
    ? 'w-56 opacity-100 max-[700px]:w-full'
    : 'w-0 opacity-0 pointer-events-none';
  const toggleStateClass = isOpen
    ? 'w-0 overflow-hidden opacity-0 pointer-events-none'
    : 'w-9 opacity-100';

  return `
    <div class="flex flex-wrap items-center gap-2 max-[700px]:w-full" data-search-root data-search-open="${isOpen}">
      <button
        type="button"
        class="flex h-9 shrink-0 cursor-pointer items-center justify-center text-muted transition-[width,opacity] duration-200 ease-out hover:text-primary ${toggleStateClass}"
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

// The source repository credited in the footer.
const SOURCE_REPOSITORY_URL = 'https://github.com/qianhujia/chinapoll';

export function renderFooter(): string {
  const dataUrl = getPublicSettings().data_repository_url;
  // The credit names the site inside a link to the source repository. The site
  // name is admin-controlled, so it is escaped before it is interpolated.
  const siteLink = `<a class="font-bold text-primary" href="${SOURCE_REPOSITORY_URL}" target="_blank" rel="noopener noreferrer">${escapeHtml(getSiteName())}</a>`;
  // A translation that omits the placeholder still keeps the site link.
  const credit = t('poweredBy');
  const creditHtml = credit.includes('{name}') ? credit.replace('{name}', siteLink) : `${credit} ${siteLink}`;

  return `
    <footer class="mt-9 flex flex-wrap items-center justify-center gap-3 text-center text-[0.9rem] text-muted">
      <span>${creditHtml}</span>
      ${dataUrl ? `<a class="text-primary" href="${escapeHtml(dataUrl)}" target="_blank" rel="noopener noreferrer">${t('dataLink')}</a>` : ''}
    </footer>
  `;
}

// Renders a one-time recovery code. The plaintext code appears here only; the
// server keeps just its hash.
export function renderRecoveryCode(code: string): string {
  return `
    <div class="grid gap-3" data-recovery-code>
      <h2 class="m-0 text-xl font-bold">${t('recoveryCodeTitle')}</h2>
      <p class="m-0 text-muted">${t('recoveryCodeBody')}</p>
      <p class="m-0 rounded-[14px] border border-border bg-[#f9fbff] px-4 py-3 font-mono tracking-wider text-sm [overflow-wrap:anywhere]">${escapeHtml(code)}</p>
      <p class="m-0 rounded-[14px] border border-[#f0c36d] bg-[#fff7e6] px-3.5 py-3 text-sm text-ink" role="note">${t('recoveryCodeWarning')}</p>
    </div>
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

// The entries of one comment's menu. A comment this browser already reported shows
// the confirmation note in place of the report entry, exactly as the poll menu does
// for the poll.
export function commentMenuEntriesMarkup(publicId: string): string {
  return hasCommentReportedLocally(publicId)
    ? `<p class="m-0 px-3 py-2 text-sm text-muted" data-comment-report-already>${t('reportCommentAlreadySent')}</p>`
    : `<button type="button" class="w-full cursor-pointer rounded-lg px-3 py-2 text-left text-sm text-ink transition-colors hover:bg-primary-soft hover:text-primary" role="menuitem" data-comment-report-open="${escapeHtml(publicId)}">${t('reportLink')}</button>`;
}

// The three-dot menu of one comment: the report action for the comment itself. The
// panel id is derived from the comment's public id so every menu on the page has its
// own target.
export function commentMenuMarkup(publicId: string): string {
  const label = escapeHtml(t('commentMoreActions'));
  const panelId = `comment-menu-${escapeHtml(publicId)}`;
  return `
            <div class="relative shrink-0" data-comment-menu-root>
              <button type="button" class="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full text-muted transition-colors hover:text-primary" data-comment-menu-toggle aria-expanded="false" aria-haspopup="menu" aria-controls="${panelId}" aria-label="${label}" title="${label}">${moreIconMarkup('h-4 w-4')}</button>
              <div class="absolute right-0 z-20 mt-1 w-44 rounded-xl border border-border bg-panel p-1 shadow-card" id="${panelId}" role="menu" aria-label="${label}" data-comment-menu hidden>
        ${commentMenuEntriesMarkup(publicId)}
              </div>
            </div>`;
}

// A comment timestamp in the visitor's own time zone and the site's language, for
// example "Oct 24, 2026, 6:33 PM" for English or "2026年10月24日 18:33" for Chinese.
// The exact value stays in the `datetime` attribute, and a value the browser cannot
// parse is shown unchanged instead of being dropped.
export function friendlyDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const locale = resolveLocale(getPublicSettings().default_locale ?? DEFAULT_LOCALE);
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  } catch {
    return value;
  }
}

export function renderCommentsContent(
  pollId: number,
  response: CommentsResponse,
  signedIn: boolean = getCurrentUser() !== null
): string {
  const totalPages = Math.ceil(response.total / response.pageSize);
  const comments = response.comments.length
    ? `<ul class="m-0 grid list-none gap-3.5 p-0">${response.comments.map(({ id, comment, createdAt }) => `
        <li class="flex items-start gap-3 border-b border-border py-3.5">
          <p class="m-0 min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">${escapeHtml(comment)}</p>
          <time class="shrink-0 pt-1 text-xs text-muted" datetime="${escapeHtml(createdAt)}">${escapeHtml(friendlyDate(createdAt))}</time>
          ${id ? commentMenuMarkup(id) : ''}
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

// Small badge that names the ballot shape of a poll, using the same badge style
// as the mode badge. It names the type only: the list rows do not repeat how many
// options a poll carries.
export function renderPollTypeBadge(pollType: string): string {
  const label = pollType === 'verdict'
    ? t('pollTypeVerdict')
    : pollType === 'multi_choice'
      ? t('pollTypeMultiChoice')
      : t('pollTypeSingleChoice');
  return `<span class="shrink-0 rounded-full bg-[#eef3fb] px-[9px] py-[3px] text-xs leading-[1.5] font-light whitespace-nowrap text-muted">${label}</span>`;
}

export function getNavigationMarkup(activeRoute: string): string {
  // Log in, sign up, and the account ("My") link are grouped on the right side
  // of the navbar (see renderHeaderAuthActions), so the navigation lists only
  // the informational pages. The header search follows these items in the navbar.
  const links = [
    { route: '/', label: t('home') },
    { route: '/about', label: t('about') },
    { route: '/submit', label: t('propose') }
  ];

  return links.map(({ route, label }) => `
    <a class="py-1 text-muted no-underline hover:text-primary ${activeRoute === route ? 'font-bold text-primary' : ''}" href="${route}" data-route="${route}">${label}</a>
  `).join('');
}
