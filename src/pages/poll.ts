import {
  createToken,
  getComments,
  getPoll,
  getStats,
  getVoteStatus,
  hasReportedLocally,
  hasVotedLocally,
  hashToken,
  markCommentReportedLocally,
  markReportedLocally,
  markVotedLocally,
  recordViewOnce,
  REPORT_REASONS,
  submitComment,
  submitReport,
  submitVote,
  type CommentsResponse,
  type PollNeighbor,
  type PollOption,
  type PollResults,
  type PollSummary,
  type PollType,
  type PollViewCounts,
  type ReportReason,
  type VoteResponse
} from '../lib/poll';
import { getCurrentUser } from '../lib/session';
import { bootstrapPoll } from '../bootstrap';
import { getPublicSettings } from '../config';
import { updateSeo } from '../seo';
import { localizedTopicName } from '../../shared/categories';
import { obtainTurnstileToken, renderTurnstile, resetTurnstile, revealTurnstile, turnstileSiteKey } from '../lib/turnstile';
import { apiErrorCode } from '../lib/apiError';
import {
  animateLayoutChange,
  chevronLeftIconMarkup,
  chevronRightIconMarkup,
  commentMenuEntriesMarkup,
  getCommentsPerPage,
  escapeHtml,
  getErrorMessage,
  getQueryPage,
  moreIconMarkup,
  renderCommentsContent,
  renderFooter,
  renderHeader,
  renderModeBadge,
  renderPollTypeBadge,
  renderToast,
  shareIconMarkup,
  showToast,
  t,
  updateComments,
  viewIconMarkup
} from '../ui';

// i18n key for each report reason, in the order the reasons are shown.
const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  spam: 'reportReasonSpam',
  inappropriate: 'reportReasonInappropriate',
  misleading: 'reportReasonMisleading',
  copyright: 'reportReasonCopyright',
  personal_info: 'reportReasonPersonalInfo',
  harassment: 'reportReasonHarassment',
  illegal: 'reportReasonIllegal',
  other: 'reportReasonOther'
};

// The share of the ballots cast that one option holds, as a whole percent: `95%`
// rather than `94.69%`, so the number stays clear at a glance. It is the share of
// the ballots, never of the other options' counts.
export function optionSharePercent(count: number, ballots: number): number {
  const share = ballots > 0 ? count / ballots * 100 : 0;
  return Math.round(share);
}

// The standing of one option as it is rendered beside it: the count stays visible,
// while the whole-percent share sits in its own `data-share-percent` slot and is
// revealed only while the row is hovered or tapped (see the stylesheet and
// `bindShareReveal`). `count` is undefined while the server withholds the counts,
// and the standing then renders nothing at all.
function optionShareMarkup(count: number | undefined, ballots: number): string {
  if (count === undefined) return '';
  return `${count}<span data-share-percent> · ${optionSharePercent(count, ballots)}%</span>`;
}

// Radio (verdict and single choice) or checkbox (multiple choice) list. A verdict
// poll takes the same single ballot as a single choice poll, so it renders radios
// too. The submit button stays disabled until the ballot is complete, and a
// returning voter sees their stored options pre-checked and the form disabled. Each
// option carries its standing twice over: the count on the right, whose whole-percent
// share the row reveals while it is hovered or tapped, and a background filled in
// proportion to that share, so the colour of the row and the numbers both belong to
// the choice they sit in. `results` is null while the server withholds the counts,
// and the standing then stays hidden until a ballot makes it public.
export function renderChoiceInputs(
  pollType: PollType,
  options: PollOption[],
  hasVoted: boolean,
  selectedIds: number[] = [],
  results: PollResults | null = null
): string {
  const inputType = pollType === 'multi_choice' ? 'checkbox' : 'radio';
  const counts = new Map((results?.options ?? []).map((option) => [option.id, Number(option.count ?? 0)]));
  const ballots = results?.ballots ?? 0;
  return `
    <form class="choice-stack mx-auto mt-6 grid w-full max-w-[420px] gap-2.5" data-choice-form data-poll-type="${pollType}" title="${hasVoted ? t('alreadyVoted') : ''}">
      <fieldset class="m-0 grid gap-2 border-0 p-0">
        <legend class="sr-only">${t('vote')}</legend>
        ${options.map((option) => {
    const count = counts.get(option.id);
    const share = count === undefined || ballots === 0 ? 0 : count / ballots * 100;
    return `
          <label class="relative flex cursor-pointer items-center gap-2.5 overflow-hidden rounded-[14px] border border-border bg-[#f9fbff] px-3.5 py-2.5" data-share-row>
            <span class="absolute inset-y-0 left-0 bg-primary-soft" data-choice-fill style="width:${share.toFixed(1)}%"${count === undefined ? ' hidden' : ''}></span>
            <input class="relative accent-primary" type="${inputType}" name="option" value="${option.id}" data-choice-option${selectedIds.includes(option.id) ? ' checked' : ''} ${hasVoted ? 'disabled' : ''}>
            <span class="relative">${escapeHtml(option.label)}</span>
            <span class="relative ml-auto shrink-0 pl-3 text-sm tabular-nums text-muted" data-choice-share${count === undefined ? ' hidden' : ''}>${optionShareMarkup(count, ballots)}</span>
          </label>
        `;
  }).join('')}
      </fieldset>
      <button class="mx-auto cursor-pointer rounded-full border border-primary bg-primary px-4 py-2.5 text-white disabled:cursor-not-allowed disabled:opacity-60" type="submit" data-choice-submit ${hasVoted ? 'disabled' : ''}>${t('submitVote')}</button>
    </form>
  `;
}

// The previous/next links for the detail page. The pair sits at the bottom of the
// poll's own box rather than in a card of its own, so a poll and its neighbors read
// as one block; the margin above the pair and the muted link text are what set them
// apart from the content they follow. The previous poll stays on the left and the
// next on the right, each showing a chevron, its public number, and its title; the
// direction is carried by the icon and the accessible name, not by visible label
// text. Returns an empty string when the poll sits at both ends of the list, so no
// empty navigation is rendered. The labels read as light muted text rather than as
// body copy. The markup mirrors the server-rendered nav in
// worker/services/ssr.ts so the first paint and the client paint look alike.
export function renderPollNav(prev: PollNeighbor | null, next: PollNeighbor | null): string {
  if (!prev && !next) return '';
  const label = (neighbor: PollNeighbor): string => escapeHtml(`#${neighbor.number} ${neighbor.title}`);
  const prevLink = prev
    ? `<a class="flex min-w-0 items-center gap-2 text-muted no-underline hover:text-primary" href="/poll/${prev.number}" data-route="/poll/${prev.number}" aria-label="${escapeHtml(t('prevPoll'))}" data-poll-nav="prev">${chevronLeftIconMarkup('h-4 w-4 shrink-0')}<span class="truncate text-sm font-light">${label(prev)}</span></a>`
    : '';
  const nextLink = next
    ? `<a class="ml-auto flex min-w-0 items-center gap-2 text-muted no-underline hover:text-primary" href="/poll/${next.number}" data-route="/poll/${next.number}" aria-label="${escapeHtml(t('nextPoll'))}" data-poll-nav="next"><span class="truncate text-sm font-light">${label(next)}</span>${chevronRightIconMarkup('h-4 w-4 shrink-0')}</a>`
    : '';
  return `
          <nav class="mt-6 flex flex-wrap items-center gap-3" aria-label="${escapeHtml(t('pollNavLabel'))}">${prevLink}${nextLink}</nav>`;
}

// One horizontal bar per option, sorted by position, showing the count and the
// share of ballots. This is the single results renderer for every poll; it never
// shows which options were picked together on one ballot. Like the ballot rows, the
// count is visible and the whole-percent share waits for a hover or a tap.
export function renderResults(results: PollResults): string {
  const options = [...(results.options ?? [])].sort((left, right) => left.position - right.position);
  if (options.length === 0) return '';
  return `
    <div class="mx-auto mt-4 grid w-full max-w-[420px] gap-2.5" data-results>
      ${options.map((option) => {
    const count = Number(option.count ?? 0);
    // The bar keeps the unrounded share, so its width stays smooth from one ballot
    // to the next while the label beside it reads as a whole percent.
    const width = results.ballots > 0 ? count / results.ballots * 100 : 0;
    return `
        <div class="grid gap-1" data-result-option="${option.id}" data-share-row>
          <div class="flex items-baseline justify-between gap-3 text-sm">
            <span class="min-w-0 truncate">${escapeHtml(option.label)}</span>
            <span class="shrink-0 tabular-nums text-muted" data-result-count>${optionShareMarkup(count, results.ballots)}</span>
          </div>
          <div class="h-2 w-full overflow-hidden rounded-full bg-[#edf0f4]">
            <div class="h-full rounded-full bg-primary" data-result-bar style="width:${width.toFixed(1)}%"></div>
          </div>
        </div>
      `;
  }).join('')}
    </div>
  `;
}

// The poll description. It is clamped to two lines by default; when the text
// overflows that clamp, `bindDescription` reveals a toggle that expands and
// collapses it. The toggle is rendered hidden so a short description never
// carries a pointless control.
export function renderPollDescription(description: string): string {
  return `
            <div class="mt-3 grid gap-1" data-poll-description>
              <p class="m-0 whitespace-pre-wrap text-ink line-clamp-2" data-description-text>${escapeHtml(description)}</p>
              <button type="button" class="justify-self-start cursor-pointer bg-transparent p-0 text-sm text-primary" data-action="toggle-description" aria-expanded="false" data-expand-label="${escapeHtml(t('descriptionExpand'))}" data-collapse-label="${escapeHtml(t('descriptionCollapse'))}" hidden>${escapeHtml(t('descriptionExpand'))}</button>
            </div>`;
}

// Reveals the description toggle only when the text overflows the two-line clamp,
// then expands and collapses the text on click. The full height is measured with
// the clamp removed, so a description that already fits stays fully visible and
// keeps no toggle. The text is animated between the two heights, so the description
// opens and closes instead of snapping between two lines and the rest.
export function bindDescription(app: HTMLElement): void {
  const wrap = app.querySelector<HTMLElement>('[data-poll-description]');
  const text = wrap?.querySelector<HTMLElement>('[data-description-text]');
  const toggle = wrap?.querySelector<HTMLButtonElement>('[data-action="toggle-description"]');
  if (!text || !toggle) return;

  const clampedHeight = text.clientHeight;
  text.classList.remove('line-clamp-2');
  const fullHeight = text.scrollHeight;
  text.classList.add('line-clamp-2');

  // A description that already fits within two lines needs no toggle.
  if (fullHeight <= clampedHeight + 1) {
    text.classList.remove('line-clamp-2');
    return;
  }

  toggle.hidden = false;
  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.textContent = expanded
      ? (toggle.dataset.collapseLabel ?? '')
      : (toggle.dataset.expandLabel ?? '');
    animateLayoutChange(text, expanded, (value) => text.classList.toggle('line-clamp-2', !value));
  });
}

// Shares the poll's own address. The address is the canonical `/poll/<number>`, so
// what is shared never carries the page's query string or hash. A browser with a share
// sheet - a phone, mostly - hands the poll to it; everywhere else the link goes to the
// clipboard and a toast confirms it. Dismissing the share sheet without choosing
// anything is not a failure, so it reports nothing and does not copy behind the
// visitor's back.
export async function sharePoll(number: number, title: string): Promise<void> {
  const url = `${window.location.origin}/poll/${number}`;
  const shareSheet = (navigator as Navigator & {
    share?: (data: { title?: string; url?: string }) => Promise<void>;
  }).share;

  if (typeof shareSheet === 'function') {
    try {
      await shareSheet.call(navigator, { title: `#${number} ${title}`, url });
      return;
    } catch (error) {
      if ((error as DOMException | undefined)?.name === 'AbortError') return;
    }
  }

  try {
    await navigator.clipboard.writeText(url);
    showToast(t('shareCopied'));
  } catch (error) {
    showToast(`${t('shareFailed')} ${getErrorMessage(error)}`, 'error');
  }
}

// The standing beside an option shows its count and holds its whole-percent share
// back until the visitor asks for it. A pointer reveals that share on hover through
// the stylesheet; a touch device has no hover, so a tap toggles `data-share-open` on
// the row instead. Only one row is open at a time, and a tap outside every row closes
// it, so the standings never fill up with shares nobody asked for.
export function bindShareReveal(app: HTMLElement): void {
  app.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const tapped = target?.closest<HTMLElement>('[data-share-row]') ?? null;
    const wasOpen = tapped?.hasAttribute('data-share-open') ?? false;
    app.querySelectorAll<HTMLElement>('[data-share-row]').forEach((row) => {
      row.removeAttribute('data-share-open');
    });
    if (tapped && !wasOpen) tapped.setAttribute('data-share-open', '');
  });
}

// The poll's actions at the top right of the title: a share button, and the three-dot
// "more actions" menu that hosts the report entry. The share button sits to the left
// of the dots and copies the poll's own address, or hands it to the browser's share
// sheet where there is one. A browser that already reported the poll sees the
// confirmation note in place of the report entry.
export function renderPollMenu(pollId: number, alreadyReported: boolean): string {
  const label = escapeHtml(t('moreActions'));
  const shareLabel = escapeHtml(t('sharePoll'));
  return `
    <div class="flex shrink-0 items-center gap-1">
      <button
        type="button"
        class="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full text-muted transition-colors hover:text-primary"
        data-poll-share
        aria-label="${shareLabel}"
        title="${shareLabel}"
      >
        ${shareIconMarkup('h-5 w-5')}
      </button>
      <div class="relative shrink-0" data-poll-menu-root>
        <button
          type="button"
          class="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full text-muted transition-colors hover:text-primary"
          data-poll-menu-toggle
          aria-expanded="false"
          aria-haspopup="menu"
          aria-controls="poll-menu"
          aria-label="${label}"
          title="${label}"
        >
          ${moreIconMarkup('h-5 w-5')}
        </button>
        <div
          class="absolute right-0 z-20 mt-2 w-48 rounded-xl border border-border bg-panel p-1 shadow-card"
          id="poll-menu"
          role="menu"
          aria-label="${label}"
          data-poll-menu
          hidden
        >
          ${pollMenuEntriesMarkup(alreadyReported)}
        </div>
        <div class="fixed inset-0 z-10" data-poll-menu-backdrop hidden></div>
      </div>
    </div>
  `;
}

// The entries of the poll menu. They are rebuilt in place after a report, so the
// report entry stays in step with this browser's state.
export function pollMenuEntriesMarkup(alreadyReported: boolean): string {
  return `${reportMenuEntryMarkup(alreadyReported)}`;
}

// The report entry of the poll menu. A browser that already reported the poll
// sees the confirmation note in place of the button.
export function reportMenuEntryMarkup(alreadyReported: boolean): string {
  if (alreadyReported) {
    return `<p class="m-0 px-3 py-2 text-sm text-muted" data-report-already>${t('reportAlreadySent')}</p>`;
  }

  return `<button
          type="button"
          class="w-full cursor-pointer rounded-lg px-3 py-2 text-left text-sm text-ink transition-colors hover:bg-primary-soft hover:text-primary"
          role="menuitem"
          data-report-open
        >${t('reportLink')}</button>`;
}

// The report dialog. It is built when the report entry is chosen and removed
// again on cancel or once the report is sent, so the page itself never carries a
// trailing report card. The page supplies the overlay that centres this card.
export function reportModalMarkup(): string {
  return `
    <div class="grid max-h-full w-full max-w-[520px] gap-3 overflow-auto rounded-[22px] border border-border bg-panel p-6 shadow-card" role="dialog" aria-modal="true" aria-labelledby="report-modal-title" data-report-dialog>
      <form class="grid gap-3" data-report-form>
        <h2 class="m-0 text-lg font-bold" id="report-modal-title">${t('reportTitle')}</h2>
        <fieldset class="m-0 grid gap-2 border-0 p-0">
          <legend class="sr-only">${t('reportTitle')}</legend>
          ${REPORT_REASONS.map((reason) => `
            <label class="flex cursor-pointer items-center gap-2.5 rounded-[14px] border border-border bg-[#f9fbff] px-3.5 py-2.5">
              <input type="radio" name="report-reason" value="${reason}" data-report-reason>
              <span>${t(REPORT_REASON_LABELS[reason])}</span>
            </label>
          `).join('')}
        </fieldset>
        <div class="grid gap-1" data-report-note-wrap hidden>
          <textarea class="w-full resize-y rounded-[14px] border border-border bg-[#f9fbff] px-3.5 py-3" data-report-note maxlength="300" rows="3" placeholder="${t('reportNotePlaceholder')}"></textarea>
          <div class="text-right text-xs text-muted"><span data-report-note-count>0</span>/300</div>
        </div>
        ${turnstileSiteKey() ? '<div class="flex justify-center" data-turnstile-report></div>' : ''}
        <div class="flex flex-wrap items-center justify-end gap-2.5">
          <button class="cursor-pointer rounded-full border border-border bg-panel px-4 py-2.5 text-sm text-ink hover:border-primary hover:text-primary" type="button" data-report-cancel>${t('reportCancel')}</button>
          <button class="cursor-pointer rounded-full border border-primary bg-primary px-4 py-2.5 text-white disabled:cursor-not-allowed disabled:opacity-60" type="button" data-report-submit disabled>${t('reportSubmit')}</button>
        </div>
        <p class="m-0 min-h-5 text-center text-[0.9rem] text-muted" role="status" aria-live="polite" data-report-status></p>
      </form>
    </div>
  `;
}

// The comments card header. The action sits at the right edge of the row, pushed
// there by `ml-auto`: a signed-in visitor gets a Comment button that reveals the
// form card above the list and moves the caret to the textarea, and a signed-out
// visitor gets a sign-in button that leads to the login page instead of a comment
// form. `ml-auto` rather than `justify-between` keeps the action on the right even
// when the row wraps on a narrow screen.
export function renderCommentsHeader(signedIn: boolean): string {
  const action = signedIn
    ? `<button class="ml-auto shrink-0 cursor-pointer rounded-full border border-primary bg-primary px-4 py-2.5 text-white" type="button" aria-expanded="false" aria-controls="comment-form" data-toggle-comment>${t('commentToggle')}</button>`
    : `<a class="ml-auto shrink-0 cursor-pointer rounded-full border border-primary bg-primary px-4 py-2.5 text-white no-underline" href="/login" data-route="/login">${t('commentLoginAction')}</a>`;
  return `
    <div class="mb-3.5 flex flex-wrap items-center gap-3">
      <h2 class="m-0 text-xl font-bold">${t('commentsTitle')}</h2>
      ${action}
    </div>
  `;
}

// The comment form card above the comments list, shown only to a signed-in
// visitor. The card itself is the toggle target, so collapsing it leaves no empty
// card behind. A signed-out visitor has no form: the comments header carries the
// sign-in button that leads to the login page.
export function renderCommentForm(signedIn: boolean): string {
  if (!signedIn) return '';

  return `
    <section class="grid gap-3 rounded-[22px] border border-border bg-panel p-6 shadow-card" id="comment-form" hidden>
      <label for="comment">${t('accountComment')}</label>
      <textarea class="w-full resize-y rounded-[14px] border border-border bg-[#f9fbff] px-3.5 py-3" id="comment" minlength="5" maxlength="140" rows="4" placeholder="${t('commentPlaceholder')}"></textarea>
      <button class="mx-auto cursor-pointer rounded-full border border-primary bg-primary px-4 py-2.5 text-white" type="button" data-submit-comment>${t('submitComment')}</button>
      <p class="comment-submit-status m-0 min-h-5 text-[0.9rem] text-muted" role="status" aria-live="polite"></p>
      <p class="comment-id-note m-0 hidden text-[0.8rem] text-muted [overflow-wrap:anywhere]"></p>
    </section>
  `;
}

// `identifier` is the public number the route carries. The primary key is only
// used for the API calls that address a poll internally, never for a link.
export async function mountVotePage(identifier: number, app: HTMLElement, bindNavigation: () => void): Promise<void> {
  const commentsPerPage = getCommentsPerPage();
  const commentsPage = getQueryPage('commentsPage');
  // The document may already carry this page's poll data (see
  // worker/services/bootstrap.ts). Using it removes the detail, results, and
  // comment requests on the first load. The anonymous vote status is never part of
  // it, because it depends on this browser's own token, so it is always fetched.
  const embedded = bootstrapPoll(identifier, commentsPage, commentsPerPage);
  let poll: PollSummary;
  let views: PollViewCounts | null = null;
  try {
    // `detail` is the GET /api/polls/<id> body: the poll plus its view counts.
    const loaded = embedded?.detail as { poll: PollSummary; views: PollViewCounts | null } | undefined;
    if (loaded?.poll) {
      poll = loaded.poll;
      views = loaded.views ?? null;
    } else {
      const fetched = await getPoll(identifier);
      poll = fetched.poll;
      views = fetched.views;
    }
  } catch (error) {
    const message = getErrorMessage(error);
    app.innerHTML = `
      <div class="mx-auto max-w-[var(--page-width)] px-5 pt-6 pb-16">
        ${renderHeader('/')}
        <main class="grid gap-5"><p class="m-0 text-center text-muted">${message.includes('(404)') ? t('pollNotFound') : `${t('pollsLoadFailed')} ${message}`}</p></main>
        ${renderFooter()}
      </div>
    `;
    bindNavigation();
    return;
  }

  // Count this open once the poll has loaded. The browser deduplicates itself
  // per tab session; the call is fire-and-forget.
  void recordViewOnce(poll.id);

  // The route's placeholder title (for example "Poll #12") is replaced with the
  // poll's own title and description now that they have loaded, matching the
  // server-rendered metadata instead of leaving the generic placeholder.
  const { site_name: siteName } = getPublicSettings();
  updateSeo({
    title: `#${poll.number} ${poll.title} - ${siteName}`,
    ...(poll.description ? { description: poll.description.slice(0, 160) } : {})
  });

  const token = createToken();
  // The base token identifies the browser; mixing in the poll id means the
  // server only ever sees a per-poll value, so votes on different polls cannot
  // be linked through the stored hash.
  const hash = await hashToken(`${token}:${poll.id}`);
  let hasVoted = hasVotedLocally(poll.id, hash);
  let voteStatusError = '';
  // The island's results payload is the same body GET /api/stats/<id> answers with.
  let stats: Awaited<ReturnType<typeof getStats>> | null =
    (embedded?.stats as Awaited<ReturnType<typeof getStats>> | undefined) ?? null;
  let statsError = '';
  if (!stats) {
    try {
      stats = await getStats(poll.id);
    } catch (error) {
      statsError = getErrorMessage(error);
    }
  }
  // The stored vote status drives the form: a returning voter sees the options
  // they already chose pre-checked, even while the counts are hidden.
  let votedOptionIds: number[] = [];
  try {
    const voteStatus = await getVoteStatus(poll.id, hash);
    hasVoted ||= voteStatus.voted;
    if (voteStatus.voted) {
      markVotedLocally(poll.id, hash);
      votedOptionIds = voteStatus.optionIds;
    }
  } catch (error) {
    voteStatusError = getErrorMessage(error);
  }
  let commentsContent: string;
  try {
    // The island carries the comment page the document was rendered for, and only
    // it: any other page is fetched.
    const embeddedComments = embedded?.comments as CommentsResponse | undefined;
    commentsContent = renderCommentsContent(
      poll.id,
      embeddedComments ?? await getComments(poll.id, commentsPage, commentsPerPage),
      getCurrentUser() !== null
    );
  } catch {
    commentsContent = t('commentsLoadFailed');
  }
  const pollType: PollType = poll.pollType ?? stats?.pollType ?? 'single_choice';
  // The options come from the server: `poll.options` is the label list from the
  // poll detail, and `stats.options` is the same list with the counts, which is
  // null while the results are withheld.
  const pollOptions = poll.options ?? [];
  const resultOptions = stats?.options ?? null;
  const results: PollResults | null = stats
    ? {
      pollType,
      ballots: stats.ballots,
      hidden: stats.hidden,
      threshold: stats.threshold,
      options: stats.options
    }
    : null;
  // Whether the results are hidden is a separate concern from whether voting is
  // allowed: the threshold hides counts, it never closes the poll.
  const resultsHidden = stats?.hidden === true;
  const canComment = getCurrentUser() !== null;
  // Voting is disabled only for a poll that is not open, a visitor who has
  // already voted, or a failed vote-status lookup.
  const votingDisabled = hasVoted || Boolean(voteStatusError) || poll.status !== 'open';
  // The threshold notice sits next to the form rather than replacing it.
  const hiddenNotice = resultsHidden
    ? `<p class="mt-3 mb-0 text-center text-sm text-muted" data-results-hidden>${t('resultsHidden').replace('{n}', String(stats!.threshold))}</p>`
    : '';
  // Below the threshold the server sends `options: null` and only its message is
  // shown. Otherwise the results are handed to the ballot, so every option shows its
  // own standing, both as a number and as the width of its background: the results
  // list below is left out, and only a poll with no ballot to carry that standing (a
  // closed one, which can no longer be voted in) still renders it.
  const publicResults = results && !results.hidden ? results : null;
  const choiceInputs = pollOptions.length > 0 && poll.status === 'open'
    ? renderChoiceInputs(pollType, pollOptions, votingDisabled, votedOptionIds, publicResults)
    : '';
  const resultsMarkup = publicResults && !choiceInputs
    ? renderResults({ ...publicResults, options: resultOptions })
    : '';
  const ballotTotal = results ? results.ballots : 0;
  // The ballot total is only published once the results are visible; below the
  // threshold the threshold notice takes its place.
  const showsBallotTotal = Boolean(results) && !resultsHidden;
  // The view count is shown in the title row when it clears the display
  // threshold; otherwise `views` is null and nothing is rendered.
  const viewsLine = views
    ? `<span class="inline-flex shrink-0 items-center gap-1 text-xs text-muted" title="${t('views')}">${viewIconMarkup('h-3.5 w-3.5')}${views.total}</span>`
    : '';
  const alreadyReported = hasReportedLocally(poll.id);
  // The claim entries need a session, so a signed-out visitor sees a sign-in link
  // instead of the claim button.
  const signedIn = getCurrentUser() !== null;
  app.innerHTML = `
    <div class="mx-auto max-w-[var(--page-width)] px-5 pt-6 pb-16">
      ${renderHeader('/')}

      <main class="grid gap-5">
        <section class="rounded-[22px] border border-border bg-panel p-6 shadow-card">
          <div class="flex items-start justify-between gap-4">
            <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
              <h1 class="m-0 text-2xl font-bold">#${poll.number} ${escapeHtml(poll.title)}</h1>
              ${renderModeBadge(poll.mode, poll.end_at)}
              ${renderPollTypeBadge(pollType)}
              ${poll.topic
    ? `<span class="shrink-0 rounded-full bg-[#eef3fb] px-2.5 py-1 text-xs text-muted" data-poll-topic>${escapeHtml(localizedTopicName(poll.topic.slug, poll.topic.name, (getPublicSettings().default_locale ?? 'en') as 'en' | 'zh-CN' | 'zh-TW'))}</span>`
    : ''}
              ${viewsLine}
            </div>
            ${renderPollMenu(poll.id, alreadyReported)}
          </div>

          ${poll.description ? renderPollDescription(poll.description) : ''}

          ${choiceInputs}

          ${resultsMarkup}

          ${hiddenNotice}

          ${showsBallotTotal ? `
            <p class="m-0 mt-3 flex items-center justify-center gap-3 text-center text-xs text-muted">
              <span data-ballot-total>${ballotTotal} ${t('ballots')}</span>
            </p>
          ` : ''}

          ${turnstileSiteKey() ? '<div class="mx-auto mt-4 flex justify-center" data-turnstile-vote></div>' : ''}

          <p class="vote-status m-0 text-center text-muted" role="status">${voteStatusError
    ? `${t('voteStatusFailed')} ${voteStatusError}`
    : statsError
      ? `${t('statsLoadFailed')} ${statsError}`
    : ''}</p>

          ${renderPollNav(poll.prev ?? null, poll.next ?? null)}
        </section>

        ${renderCommentForm(canComment)}

        <section class="rounded-[22px] border border-border bg-panel p-6 shadow-card">
          ${renderCommentsHeader(canComment)}
          <div id="comments-content">${commentsContent}</div>
        </section>
      </main>
      ${renderToast()}
      ${renderFooter()}
    </div>
  `;

  const commentToggle = document.querySelector<HTMLButtonElement>('[data-toggle-comment]');
  const commentForm = document.querySelector<HTMLElement>('#comment-form');
  const commentButton = document.querySelector<HTMLButtonElement>('[data-submit-comment]');
  const commentInput = document.querySelector<HTMLTextAreaElement>('#comment');
  const commentStatus = document.querySelector('.comment-submit-status');
  commentToggle?.addEventListener('click', () => {
    if (!commentToggle || !commentForm) return;
    const expanded = commentToggle.getAttribute('aria-expanded') === 'true';
    commentToggle.setAttribute('aria-expanded', String(!expanded));
    commentForm.hidden = expanded;
    // The button sits at the top right of the comments list, which is below the
    // form card, so opening the form brings the textarea back into view and puts
    // the caret in it.
    if (!expanded) {
      commentForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
      commentInput?.focus({ preventScroll: true });
    }
  });
  commentButton?.addEventListener('click', async () => {
    const comment = commentInput?.value.trim() ?? '';
    if (comment.length < 5 || comment.length > 140) {
      if (commentStatus) commentStatus.textContent = t('invalidCommentLength');
      return;
    }

    commentButton.disabled = true;
    if (commentStatus) commentStatus.textContent = '';
    try {
      await submitComment(poll.id, comment);
      if (commentInput) commentInput.value = '';
      if (commentStatus) commentStatus.textContent = t('commentSubmitted');
      window.history.replaceState({}, '', `/poll/${poll.number}?commentsPage=1`);
      await updateComments(poll.id, 1, bindNavigation);
    } catch (error) {
      if (commentStatus) commentStatus.textContent = `${t('commentSubmitFailed')} ${getErrorMessage(error)}`;
    } finally {
      commentButton.disabled = false;
    }
  });

  // Every ballot is a set of option ids; a single choice ballot carries one.
  // The duplicate and closed-poll handling is shared by every poll type.
  const sendBallot = async (payload: { optionIds: number[] }) => {
    // The button stays disabled and the status line explains the wait while the
    // token is obtained, so a slow challenge never looks like a dead button.
    const submitButton = document.querySelector<HTMLButtonElement>('[data-choice-submit]');
    const voteStatus = document.querySelector<HTMLElement>('.vote-status');
    if (submitButton) submitButton.disabled = true;
    let challengeToken: string;
    try {
      if (voteStatus) voteStatus.textContent = t('verifying');
      challengeToken = await obtainTurnstileToken('vote');
    } catch (error) {
      const failure = `${t('submitFailed')}: ${getErrorMessage(error)}`;
      if (voteStatus) voteStatus.textContent = failure;
      showToast(failure, 'error');
      if (submitButton) submitButton.disabled = false;
      resetTurnstile('vote');
      return null;
    }
    if (voteStatus) voteStatus.textContent = '';

    let result;
    try {
      result = await submitVote({
        pollId: poll.id,
        tokenHash: hash,
        optionIds: payload.optionIds,
        turnstileToken: challengeToken
      });
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      // The widget is hidden by default, so a verification failure is the only
      // case that must surface the box for the visitor to solve.
      if (apiErrorCode(error) === 'TURNSTILE_FAILED') revealTurnstile('vote');
      // A 503 means the deployment is missing its server key; a 423 means the
      // site is in read-only mode. Show a clear localized message for each
      // instead of the terse server text so neither looks like a client error.
      let statusMessage = errorMessage.includes('(423)')
        ? t('readOnlyMode')
        : errorMessage.includes('(503)')
          ? t('siteNotConfigured')
          : `${t('submitFailed')}: ${errorMessage}`;
      try {
        const currentVoteStatus = await getVoteStatus(poll.id, hash);
        if (currentVoteStatus.voted) {
          hasVoted = true;
          markVotedLocally(poll.id, hash);
          statusMessage = t('alreadyVoted');
        }
      } catch {
        // Preserve the original submission error if the follow-up status check also fails.
      }
      if (hasVoted) {
        document.querySelectorAll<HTMLInputElement | HTMLButtonElement>('[data-choice-option], [data-choice-submit]')
          .forEach((voteButton) => { voteButton.disabled = true; });
        const choices = document.querySelector('.choice-stack');
        if (choices) choices.setAttribute('title', t('alreadyVoted'));
        const status = document.querySelector('.vote-status');
        if (status) status.textContent = '';
      } else {
        const status = document.querySelector('.vote-status');
        if (status) status.textContent = statusMessage;
      }
      showToast(statusMessage, hasVoted ? 'success' : 'error');
      resetTurnstile('vote');
      return null;
    }
    resetTurnstile('vote');
    return result;
  };

  // Updates the standing of every option in the ballot: the count beside it, its
  // whole-percent share in the slot the row reveals on hover or tap, and the width of
  // the background that fills it, so both the numbers and the colour of the row match
  // the results the ballot just produced. All three are rendered hidden while the
  // counts are withheld, and the first public results reveal them.
  const syncChoiceStandings = (result: PollResults) => {
    const counts = new Map((result.options ?? []).map((option) => [option.id, Number(option.count ?? 0)]));
    document.querySelectorAll<HTMLInputElement>('[data-choice-option]').forEach((optionInput) => {
      const count = counts.get(Number(optionInput.value));
      const row = optionInput.closest('label');
      const share = row?.querySelector<HTMLElement>('[data-choice-share]');
      const fill = row?.querySelector<HTMLElement>('[data-choice-fill]');
      if (count === undefined || !share || !fill) return;
      share.innerHTML = optionShareMarkup(count, result.ballots);
      share.hidden = false;
      fill.style.width = `${(result.ballots > 0 ? count / result.ballots * 100 : 0).toFixed(1)}%`;
      fill.hidden = false;
    });
  };

  // The server returns the same results shape for every poll, so one refresh path
  // updates the standing beside each choice and the ballot total after a ballot. The
  // options carry that standing themselves, so nothing is added below the vote button.
  const refreshResults = (result: VoteResponse) => {
    if (result.hidden || !result.options) return;
    syncChoiceStandings(result);
    const total = document.querySelector<HTMLElement>('[data-ballot-total]');
    if (total) {
      total.textContent = `${result.ballots} ${t('ballots')}`;
    } else {
      // The total was not rendered while the results were hidden, so it is created
      // now that the ballot pushed the poll over the threshold.
      document.querySelector('[data-choice-form]')?.insertAdjacentHTML('afterend', `<p class="m-0 mt-3 flex items-center justify-center gap-3 text-center text-xs text-muted"><span data-ballot-total>${result.ballots} ${t('ballots')}</span></p>`);
    }
  };

  // Keeps the threshold notice in step with the latest response: it stays while
  // the counts are still withheld and is removed once the ballot pushed the poll
  // over the threshold.
  const updateThresholdNotice = (result: VoteResponse) => {
    const existing = document.querySelector<HTMLElement>('[data-results-hidden]');
    if (result.hidden) {
      if (existing) return;
      const markup = `<p class="mt-3 mb-0 text-center text-sm text-muted" data-results-hidden>${t('resultsHidden').replace('{n}', String(result.threshold))}</p>`;
      document.querySelector('[data-choice-form]')?.insertAdjacentHTML('afterend', markup);
      return;
    }
    existing?.remove();
  };

  // Choice ballots for both poll types.
  const choiceForm = document.querySelector<HTMLFormElement>('[data-choice-form]');
  if (choiceForm) {
    const submitButton = choiceForm.querySelector<HTMLButtonElement>('[data-choice-submit]');
    const boxes = Array.from(choiceForm.querySelectorAll<HTMLInputElement>('[data-choice-option]'));
    const selectedIds = () => boxes.filter((box) => box.checked).map((box) => Number(box.value));

    // A single choice poll submits as soon as one option is picked; a multi
    // choice poll needs at least one box before the button is enabled.
    const sync = () => {
      if (submitButton) submitButton.disabled = hasVoted || selectedIds().length === 0;
    };
    sync();
    boxes.forEach((box) => box.addEventListener('change', sync));

    // The first interaction warms the token up, so it is usually already at hand
    // when the form is submitted. The result is deliberately ignored: the submit
    // path asks again and reports any real failure.
    let warmedUp = false;
    const warmUpToken = () => {
      if (warmedUp) return;
      warmedUp = true;
      void obtainTurnstileToken('vote').catch(() => undefined);
    };
    boxes.forEach((box) => box.addEventListener('change', warmUpToken));

    choiceForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (hasVoted || voteStatusError || statsError) return;
      const optionIds = selectedIds();
      if (optionIds.length === 0) return;
      if (submitButton) submitButton.disabled = true;

      const result = await sendBallot({ optionIds });
      if (!result) return;

      // The toast confirms the ballot without restating its size: the results beside
      // the options already show the count and share the ballot just added to.
      const message = result.ok ? t('voteRecord') : t('submitFailed');
      if (result.ok) {
        hasVoted = true;
        markVotedLocally(poll.id, hash);
        boxes.forEach((box) => { box.disabled = true; });
        if (submitButton) submitButton.disabled = true;
        const stack = document.querySelector<HTMLElement>('.choice-stack');
        if (stack) stack.setAttribute('title', t('alreadyVoted'));
        refreshResults(result);
        updateThresholdNotice(result);
      }
      showToast(message, result.ok ? 'success' : 'error');
    });
  }

  // Render the Turnstile widget on the vote area when a site key is configured.
  // It stays hidden until Cloudflare needs an interaction, so the empty slot adds
  // no visible element and the script loads in the background without blocking
  // the page.
  const voteWidget = document.querySelector<HTMLElement>('[data-turnstile-vote]');
  if (voteWidget) void renderTurnstile('vote', voteWidget);

  // The three-dot poll menu: the toggle opens the dropdown that hosts the report
  // entry, the backdrop closes it on a click anywhere outside, and Escape closes
  // it from the toggle or an entry.
  const menuToggle = document.querySelector<HTMLButtonElement>('[data-poll-menu-toggle]');
  const menuPanel = document.querySelector<HTMLElement>('[data-poll-menu]');
  const menuBackdrop = document.querySelector<HTMLElement>('[data-poll-menu-backdrop]');
  const setMenuOpen = (open: boolean) => {
    if (menuPanel) menuPanel.hidden = !open;
    if (menuBackdrop) menuBackdrop.hidden = !open;
    menuToggle?.setAttribute('aria-expanded', String(open));
  };
  const closeMenu = () => setMenuOpen(false);
  menuToggle?.addEventListener('click', () => setMenuOpen(menuPanel?.hidden !== false));
  menuBackdrop?.addEventListener('click', closeMenu);
  for (const element of [menuToggle, menuPanel]) {
    element?.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeMenu();
    });
  }

  // The share button hands the poll's canonical address to the browser's share sheet
  // or to the clipboard, whichever this browser offers.
  document.querySelector<HTMLButtonElement>('[data-poll-share]')
    ?.addEventListener('click', () => { void sharePoll(poll.number, poll.title); });

  // The report dialog is built when the report entry is chosen and removed again
  // on cancel or once the report is sent, so no report card is appended to the
  // page. The note field is offered only for "Other", and a submitted report is
  // remembered in localStorage so the menu entry becomes the confirmation note.
  // The report dialog is shared by a poll and a comment; the caller names the target.
  const openReportModal = async (target: { pollId: number } | { commentPublicId: string }) => {
    closeMenu();
    // The dialog opens from either menu, so the source menu is closed too;
    // leaving it open behind the dialog looks stuck.
    closeCommentMenus();
    if (app.querySelector('[data-report-modal]')) return;

    const host = document.createElement('div');
    host.className = 'fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4';
    host.dataset.reportModal = '1';
    host.innerHTML = reportModalMarkup();
    app.appendChild(host);

    const submit = host.querySelector<HTMLButtonElement>('[data-report-submit]');
    const cancel = host.querySelector<HTMLButtonElement>('[data-report-cancel]');
    const noteWrap = host.querySelector<HTMLElement>('[data-report-note-wrap]');
    const note = host.querySelector<HTMLTextAreaElement>('[data-report-note]');
    const noteCount = host.querySelector<HTMLElement>('[data-report-note-count]');
    const status = host.querySelector<HTMLElement>('[data-report-status]');
    const radios = Array.from(host.querySelectorAll<HTMLInputElement>('[data-report-reason]'));

    const selectedReason = (): ReportReason | null => {
      const checked = radios.find((radio) => radio.checked);
      return checked ? checked.value as ReportReason : null;
    };
    const close = () => {
      host.remove();
      resetTurnstile('report');
    };
    const syncNote = () => {
      const isOther = selectedReason() === 'other';
      if (noteWrap) noteWrap.hidden = !isOther;
      if (!isOther && note) note.value = '';
      if (noteCount) noteCount.textContent = String(note?.value.length ?? 0);
    };

    radios.forEach((radio) => radio.addEventListener('change', () => {
      if (submit) submit.disabled = selectedReason() === null;
      syncNote();
    }));
    note?.addEventListener('input', () => {
      if (noteCount) noteCount.textContent = String(note.value.length);
    });
    cancel?.addEventListener('click', close);
    // A click on the dimmed area and Escape both dismiss the dialog.
    host.addEventListener('click', (event) => {
      if (event.target === host) close();
    });
    host.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close();
    });
    submit?.addEventListener('click', async () => {
      const reason = selectedReason();
      if (!reason) return;
      submit.disabled = true;
      if (status) status.textContent = t('verifying');
      let challengeToken: string;
      try {
        challengeToken = await obtainTurnstileToken('report');
      } catch (error) {
        if (status) status.textContent = `${t('submitFailed')}: ${getErrorMessage(error)}`;
        submit.disabled = false;
        resetTurnstile('report');
        return;
      }
      if (status) status.textContent = '';
      try {
        await submitReport({
          ...('pollId' in target ? { pollId: target.pollId } : { commentId: target.commentPublicId }),
          reason,
          note: reason === 'other' ? (note?.value.trim() ?? '') : undefined,
          turnstileToken: challengeToken
        });
        close();
        // The reported entry becomes the confirmation note, wherever the target was.
        if ('pollId' in target) {
          markReportedLocally(target.pollId);
          refreshPollMenu();
        } else {
          markCommentReportedLocally(target.commentPublicId);
          refreshCommentMenu(target.commentPublicId);
        }
        showToast(t('reportThanks'));
      } catch (error) {
        if (status) status.textContent = `${t('submitFailed')}: ${getErrorMessage(error)}`;
        submit.disabled = false;
        // The widget is hidden by default, so a verification failure is the only
        // case that must surface the box for the visitor to solve.
        if (apiErrorCode(error) === 'TURNSTILE_FAILED') revealTurnstile('report');
        resetTurnstile('report');
      }
    });

    const widget = host.querySelector<HTMLElement>('[data-turnstile-report]');
    if (widget) await renderTurnstile('report', widget);
    radios[0]?.focus();
  };
  // Rebuilds the poll menu entries so they match the state this browser is now in.
  const refreshPollMenu = () => {
    if (menuPanel) {
      menuPanel.innerHTML = pollMenuEntriesMarkup(hasReportedLocally(poll.id));
    }
  };

  // Rebuilds one comment's menu entries without re-rendering the whole list. The
  // comment's reported state is remembered by its public id, like a poll's.
  const refreshCommentMenu = (publicId: string) => {
    const panel = document.getElementById(`comment-menu-${publicId}`);
    if (panel) {
      panel.innerHTML = commentMenuEntriesMarkup(publicId);
    }
  };

  const closeCommentMenus = () => {
    app.querySelectorAll<HTMLElement>('[data-comment-menu]').forEach((panel) => {
      panel.hidden = true;
    });
    app.querySelectorAll<HTMLButtonElement>('[data-comment-menu-toggle]').forEach((toggle) => {
      toggle.setAttribute('aria-expanded', 'false');
    });
  };

  // The poll menu entries are delegated from the panel, not bound to the buttons:
  // the entries are rebuilt in place by `refreshPollMenu` after a report, and a
  // listener bound to the old button would be dropped with its markup, leaving a
  // button that does nothing. The comment menu delegates for the same reason.
  menuPanel?.addEventListener('click', (event) => {
    const clicked = event.target as HTMLElement | null;
    if (!clicked) return;
    if (clicked.closest('[data-report-open]')) {
      void openReportModal({ pollId: poll.id });
    }
  });

  // Every comment row carries its own menu, so the handlers are delegated from the
  // comments host and survive the list being replaced by `updateComments`.
  const commentsHost = app.querySelector<HTMLElement>('#comments-content');
  commentsHost?.addEventListener('click', (event) => {
    const clicked = event.target as HTMLElement | null;
    if (!clicked) return;

    const toggle = clicked.closest<HTMLButtonElement>('[data-comment-menu-toggle]');
    if (toggle) {
      const panel = toggle.parentElement?.querySelector<HTMLElement>('[data-comment-menu]');
      if (panel) {
        const open = panel.hidden;
        closeCommentMenus();
        panel.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
      }
      return;
    }

    const reportEntry = clicked.closest<HTMLButtonElement>('[data-comment-report-open]');
    if (reportEntry) {
      const publicId = reportEntry.dataset.commentReportOpen ?? '';
      if (publicId) void openReportModal({ commentPublicId: publicId });
    }
  });
  // A click anywhere else dismisses an open comment menu.
  document.addEventListener('click', (event) => {
    const clicked = event.target as HTMLElement | null;
    if (clicked?.closest('[data-comment-menu-root]')) return;
    closeCommentMenus();
  });

  bindNavigation();
  bindDescription(app);
  bindShareReveal(app);
}
