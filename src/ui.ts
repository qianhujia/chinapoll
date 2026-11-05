import { ChevronDown, ChevronLeft, ChevronRight, CircleAlert, CircleCheck, EllipsisVertical, Eye, Menu, Plus, Search, Share2, Vote, X, type IconNode } from 'lucide';
import { DEFAULT_LOCALE, getLocaleText, resolveLocale } from './i18n';
import { getComments, hasCommentReportedLocally, type CommentsResponse, type PollSummary } from './lib/poll';
import { getCurrentUser } from './lib/session';
import { deadlineBadgeLabel } from '../shared/deadline';
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

// Share mark - three nodes joined by two lines - used by the poll's share button.
export function shareIconMarkup(cssClass: string): string {
  return iconMarkup(Share2, cssClass);
}

// Plus icon used by the "New Poll" call to action on the home hero.
export function plusIconMarkup(cssClass: string): string {
  return iconMarkup(Plus, cssClass);
}

// Ballot icon used by the vote count in the poll lists.
export function voteIconMarkup(cssClass: string): string {
  return iconMarkup(Vote, cssClass);
}

// Hamburger icon for the small-screen header menu.
export function menuIconMarkup(cssClass: string): string {
  return iconMarkup(Menu, cssClass);
}

// Chevron mark for a dropdown trigger, pointing at the list it opens.
export function chevronDownIconMarkup(cssClass: string): string {
  return iconMarkup(ChevronDown, cssClass);
}

// Chevron icons used by the previous/next poll navigation on the detail page.
export function chevronLeftIconMarkup(cssClass: string): string {
  return iconMarkup(ChevronLeft, cssClass);
}

export function chevronRightIconMarkup(cssClass: string): string {
  return iconMarkup(ChevronRight, cssClass);
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

// Grows or shrinks `element` with a short height animation instead of letting it
// jump between the two layouts, so an expanding block appears to open and a
// collapsing one to close. `setExpanded` puts the block into the requested layout;
// the helper calls it to measure the two heights, so it must be safe to call more
// than once and must always end in the requested state.
export function animateLayoutChange(
  element: HTMLElement,
  expanded: boolean,
  setExpanded: (value: boolean) => void
): void {
  // Motion is optional: without the animation API, or for a visitor who asked for
  // reduced motion, the change is simply applied.
  const reduceMotion = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (typeof element.animate !== 'function' || reduceMotion) {
    setExpanded(expanded);
    return;
  }

  const from = element.getBoundingClientRect().height;
  let to: number;
  if (expanded) {
    setExpanded(true);
    to = element.getBoundingClientRect().height;
  } else {
    // The content stays as it is while the box closes, so the height to animate to
    // is measured with the collapsed layout in place and that layout is then undone
    // to put the chips or the text back for the duration of the animation.
    setExpanded(false);
    to = element.getBoundingClientRect().height;
    setExpanded(true);
  }
  if (from === to) {
    setExpanded(expanded);
    return;
  }

  // The element is clipped while it animates so what is on its way out does not
  // poke out of the closing box; the clip is dropped once it settles, which also
  // keeps it from cropping a focus indicator afterwards.
  const overflow = element.style.overflow;
  element.style.overflow = 'hidden';
  const animation = element.animate(
    [{ height: `${from}px` }, { height: `${to}px` }],
    { duration: 200, easing: 'ease-out' }
  );
  const settle = () => {
    element.style.overflow = overflow;
    setExpanded(expanded);
  };
  animation.addEventListener('finish', settle);
  animation.addEventListener('cancel', settle);
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

  // The navigation and the account actions are inline on a wide screen. Below
  // 700px they are hidden and the same items live in the stacked menu the button
  // reveals (see renderHeaderMenuButton), so the header row keeps only the brand,
  // the search toggle, and the menu button.
  return `
    <header class="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 py-4 pb-5">
      <div class="flex flex-wrap items-center gap-x-7 gap-y-2 max-[700px]:gap-x-3">
        <a class="flex items-center" href="/" data-route="/" aria-label="${siteName}">${brand}</a>
        <nav class="flex flex-wrap items-center gap-[18px] max-[700px]:hidden" aria-label="${escapeHtml(t('home'))}">
          ${getNavigationMarkup(activeRoute)}
        </nav>
        ${renderHeaderSearch()}
      </div>
      <div class="flex flex-wrap items-center gap-2 max-[700px]:hidden">
        ${renderHeaderAuthActions(activeRoute)}
      </div>
      ${renderHeaderMenuButton()}
      ${renderHeaderMenuPanel(activeRoute)}
    </header>
  `;
}

// The small-screen header menu button, at the top right. It is hidden on a wide
// screen, where the navigation is inline, and its icon switches to a close mark
// while the panel is open.
function renderHeaderMenuButton(): string {
  const label = escapeHtml(t('menuLabel'));
  return `
      <button
        type="button"
        class="hidden h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border bg-panel text-muted hover:border-primary hover:text-primary max-[700px]:flex"
        data-menu-toggle
        aria-expanded="false"
        aria-controls="header-menu"
        aria-label="${label}"
        title="${label}"
      >
        <span data-menu-icon="closed">${menuIconMarkup('h-5 w-5 shrink-0')}</span>
        <span class="hidden" data-menu-icon="open">${closeIconMarkup('h-5 w-5 shrink-0')}</span>
      </button>
  `;
}

// The stacked menu the button reveals: the same navigation and account actions,
// one per line. It starts closed and stays hidden on a wide screen, because the
// responsive display utility that opens it only applies below 700px.
function renderHeaderMenuPanel(activeRoute: string): string {
  return `
      <nav class="hidden basis-full flex-col gap-3 border-t border-border pt-3" id="header-menu" data-menu-panel aria-label="${escapeHtml(t('menuLabel'))}">
        <div class="flex flex-col gap-2">${getNavigationMarkup(activeRoute)}
        </div>
        <div class="flex flex-wrap items-center gap-2">${renderHeaderAuthActions(activeRoute)}
        </div>
      </nav>
  `;
}

// Right-aligned account actions. Signed-out visitors see the log in link and the
// sign up button; signed-in visitors see their own account ("My") link instead.
function renderHeaderAuthActions(activeRoute: string): string {
  if (getCurrentUser() !== null) {
    const isActive = activeRoute === '/account';
    return `
      <a class="py-1 whitespace-nowrap text-muted no-underline hover:text-primary ${isActive ? 'font-bold text-primary' : ''}" href="/account" data-route="/account">${escapeHtml(t('accountNav'))}</a>
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
  // On a narrow screen an open search takes the whole row (so the field and the
  // status line have room); while it is closed the control is only the icon, so it
  // stays inline beside the brand instead of claiming a line of its own.
  const rootStateClass = isOpen ? 'max-[700px]:w-full' : '';

  return `
    <div class="flex flex-wrap items-center gap-2 ${rootStateClass}" data-search-root data-search-open="${isOpen}">
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
  // Comments are separated by space rather than by a rule: each one is its own block, and the
  // gap between the blocks keeps them apart without drawing a line between turns. The header
  // above the list carries the space under it.
  const comments = response.comments.length
    ? `<ul class="m-0 grid list-none gap-7 p-0">${response.comments.map(({ id, comment, createdAt }) => `
        <li class="flex items-start gap-3">
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

// The badge beside a poll title. A deadline poll names the time it has left instead
// of its mode, computed once when the page is rendered so it never ticks; a poll
// with no end date, or one whose end has already passed, still reads as a plain
// label. An evergreen poll keeps "Permanent".
export function renderModeBadge(mode: PollSummary['mode'], endAt?: string | null): string {
  const label = mode === 'deadline' ? deadlineBadgeLabel(endAt, Date.now(), t) : t('evergreen');
  return `<span class="shrink-0 rounded-full bg-[#f1f3f5] px-[9px] py-[3px] text-xs leading-[1.5] font-light whitespace-nowrap text-muted">${label}</span>`;
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

// The palette a poll's options are drawn in: one colour per option position, so the
// same option keeps its colour in the home list's bar diagram, in the ballot rows on
// the poll page, and in its results diagram. There is one entry per allowed option
// (see MAX_POLL_OPTIONS in ./lib/poll). The order opens green, then orange, and keeps
// the two blues for later, so the first bars of a poll never read as the site's own
// chrome; neighbouring entries stay far enough apart to be told apart at a glance.
export const OPTION_COLORS: ReadonlyArray<string> = [
  '#0f766e',
  '#c2410c',
  '#7c3aed',
  '#b45309',
  '#2563eb',
  '#be123c',
  '#0369a1'
];

// The colour of the option at one position. The index wraps, so a poll that somehow
// carries more options than the palette has entries still gets a colour rather than
// `undefined`.
export function optionColor(index: number): string {
  return OPTION_COLORS[index % OPTION_COLORS.length] ?? OPTION_COLORS[0];
}

// The share of the ballots cast that one option holds, as a whole percent: `95%`
// rather than `94.69%`, so the number stays clear at a glance. It is the share of
// the ballots, never of the other options' counts.
export function optionSharePercent(count: number, ballots: number): number {
  const share = ballots > 0 ? count / ballots * 100 : 0;
  return Math.round(share);
}

// The same share unrounded, used for a bar's width so the bar stays smooth from one
// ballot to the next while the label beside it reads as a whole percent.
export function optionShareWidth(count: number, ballots: number): number {
  return ballots > 0 ? count / ballots * 100 : 0;
}


// Brand marks for the share dialog's networks. They are inlined as a single filled path each
// rather than taken from the icon set, which ships interface icons only: the path data is the
// mark Simple Icons publishes (CC0) on the same 24x24 grid the interface icons use, so a
// network is recognisable at a glance and nothing is fetched at runtime. The mark is
// decorative - the entry's own name and its accessible label say which network it is - so it
// stays out of the accessibility tree.
const SOCIAL_ICON_PATHS: Readonly<Record<string, string>> = {
  // X
  x: 'M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z',
  // Facebook
  facebook: 'M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z',
  // WhatsApp
  whatsapp: 'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z',
  // Telegram
  telegram: 'M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z',
  // Sina Weibo
  weibo: 'M10.098 20.323c-3.977.391-7.414-1.406-7.672-4.02-.259-2.609 2.759-5.047 6.74-5.441 3.979-.394 7.413 1.404 7.671 4.018.259 2.6-2.759 5.049-6.737 5.439l-.002.004zM9.05 17.219c-.384.616-1.208.884-1.829.602-.612-.279-.793-.991-.406-1.593.379-.595 1.176-.861 1.793-.601.622.263.82.972.442 1.592zm1.27-1.627c-.141.237-.449.353-.689.253-.236-.09-.313-.361-.177-.586.138-.227.436-.346.672-.24.239.09.315.36.18.601l.014-.028zm.176-2.719c-1.893-.493-4.033.45-4.857 2.118-.836 1.704-.026 3.591 1.886 4.21 1.983.64 4.318-.341 5.132-2.179.8-1.793-.201-3.642-2.161-4.149zm7.563-1.224c-.346-.105-.57-.18-.405-.615.375-.977.42-1.804 0-2.404-.781-1.112-2.915-1.053-5.364-.03 0 0-.766.331-.571-.271.376-1.217.315-2.224-.27-2.809-1.338-1.337-4.869.045-7.888 3.08C1.309 10.87 0 13.273 0 15.348c0 3.981 5.099 6.395 10.086 6.395 6.536 0 10.888-3.801 10.888-6.82 0-1.822-1.547-2.854-2.915-3.284v.01zm1.908-5.092c-.766-.856-1.908-1.187-2.96-.962-.436.09-.706.511-.616.932.09.42.511.691.932.602.511-.105 1.067.044 1.442.465.376.421.466.977.316 1.473-.136.406.089.856.51.992.405.119.857-.105.992-.512.33-1.021.12-2.178-.646-3.035l.03.045zm2.418-2.195c-1.576-1.757-3.905-2.419-6.054-1.968-.496.104-.812.587-.706 1.081.104.496.586.813 1.082.707 1.532-.331 3.185.15 4.296 1.383 1.112 1.246 1.429 2.943.947 4.416-.165.48.106 1.007.586 1.157.479.165.991-.104 1.157-.586.675-2.088.241-4.478-1.338-6.235l.03.045z',
  // Reddit
  reddit: 'M12 0C5.373 0 0 5.373 0 12c0 3.314 1.343 6.314 3.515 8.485l-2.286 2.286C.775 23.225 1.097 24 1.738 24H12c6.627 0 12-5.373 12-12S18.627 0 12 0Zm4.388 3.199c1.104 0 1.999.895 1.999 1.999 0 1.105-.895 2-1.999 2-.946 0-1.739-.657-1.947-1.539v.002c-1.147.162-2.032 1.15-2.032 2.341v.007c1.776.067 3.4.567 4.686 1.363.473-.363 1.064-.58 1.707-.58 1.547 0 2.802 1.254 2.802 2.802 0 1.117-.655 2.081-1.601 2.531-.088 3.256-3.637 5.876-7.997 5.876-4.361 0-7.905-2.617-7.998-5.87-.954-.447-1.614-1.415-1.614-2.538 0-1.548 1.255-2.802 2.803-2.802.645 0 1.239.218 1.712.585 1.275-.79 2.881-1.291 4.64-1.365v-.01c0-1.663 1.263-3.034 2.88-3.207.188-.911.993-1.595 1.959-1.595Zm-8.085 8.376c-.784 0-1.459.78-1.506 1.797-.047 1.016.64 1.429 1.426 1.429.786 0 1.371-.369 1.418-1.385.047-1.017-.553-1.841-1.338-1.841Zm7.406 0c-.786 0-1.385.824-1.338 1.841.047 1.017.634 1.385 1.418 1.385.785 0 1.473-.413 1.426-1.429-.046-1.017-.721-1.797-1.506-1.797Zm-3.703 4.013c-.974 0-1.907.048-2.77.135-.147.015-.241.168-.183.305.483 1.154 1.622 1.964 2.953 1.964 1.33 0 2.47-.81 2.953-1.964.057-.137-.037-.29-.184-.305-.863-.087-1.795-.135-2.769-.135Z'
};

// Each network's own brand colour, the colour the network draws its mark in. It is applied to
// the mark itself and not to the pill around it, so a row still reads as the site's own while
// the mark is recognisable at a glance.
const SOCIAL_ICON_COLOURS: Readonly<Record<string, string>> = {
  x: '#000000',
  facebook: '#0866ff',
  whatsapp: '#25d366',
  telegram: '#26a5e4',
  weibo: '#df2029',
  reddit: '#ff4500'
};

// The mark of one network, drawn at the caller's size in the network's brand colour. A slug
// with no mark renders as the entry's name alone.
export function socialIconMarkup(network: string, cssClass: string): string {
  const path = SOCIAL_ICON_PATHS[network];
  if (!path) return '';
  const colour = SOCIAL_ICON_COLOURS[network] ?? 'currentColor';
  return `<svg class="${cssClass}" viewBox="0 0 24 24" fill="${colour}" aria-hidden="true"><path d="${path}" /></svg>`;
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

// Opens and closes the small-screen header menu. Like the header search, the
// binding is delegated on the document, so it also covers the server-rendered
// header and survives every re-render (which rebuilds the header markup).
export function bindHeaderMenu(): void {
  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    if (target.closest('[data-menu-toggle]')) {
      event.preventDefault();
      setHeaderMenu(headerMenuPanel()?.dataset.menuOpen !== 'true');
      return;
    }

    // A click anywhere outside the panel closes it. A navigation replaces the
    // header wholesale, which closes it as well.
    if (!target.closest('[data-menu-panel]') && headerMenuPanel()?.dataset.menuOpen === 'true') {
      setHeaderMenu(false);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setHeaderMenu(false);
  });
}

function headerMenuPanel(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-menu-panel]');
}

// The panel is opened by adding the responsive display utility its markup leaves
// out, so it can never become visible on a wide screen, where the navigation is
// inline. The button reports the state and swaps its icon.
function setHeaderMenu(open: boolean): void {
  const panel = headerMenuPanel();
  if (!panel) return;

  panel.dataset.menuOpen = String(open);
  panel.classList.toggle('max-[700px]:flex', open);
  document.querySelector<HTMLElement>('[data-menu-toggle]')?.setAttribute('aria-expanded', String(open));
  document.querySelector<HTMLElement>('[data-menu-icon="closed"]')?.classList.toggle('hidden', open);
  document.querySelector<HTMLElement>('[data-menu-icon="open"]')?.classList.toggle('hidden', !open);
}
