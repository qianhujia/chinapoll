import {
  createToken,
  getComments,
  getPoll,
  getStats,
  getVoteStatus,
  hasReportedLocally,
  hasVotedLocally,
  hashToken,
  markReportedLocally,
  markVotedLocally,
  REPORT_REASONS,
  submitComment,
  submitReport,
  submitVote,
  type PollSummary,
  type ReportReason
} from '../lib/poll';
import { getCurrentUser } from '../lib/session';
import { renderTurnstile, resetTurnstile, turnstileSiteKey, turnstileToken } from '../lib/turnstile';
import {
  getCommentsPerPage,
  escapeHtml,
  getErrorMessage,
  getQueryPage,
  renderCommentsContent,
  renderFooter,
  renderHeader,
  renderModeBadge,
  renderToast,
  renderVoteButton,
  showToast,
  t,
  updateComments,
  updateVoteGroup
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

export async function mountVotePage(pollId: number, app: HTMLElement, bindNavigation: () => void): Promise<void> {
  const commentsPerPage = getCommentsPerPage();
  let poll: PollSummary;
  try {
    poll = await getPoll(pollId);
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

  const token = createToken();
  // The base token identifies the browser; mixing in the poll id means the
  // server only ever sees a per-poll value, so votes on different polls cannot
  // be linked through the stored hash.
  const hash = await hashToken(`${token}:${poll.id}`);
  let hasVoted = hasVotedLocally(poll.id, hash);
  let voteStatusError = '';
  let stats: Awaited<ReturnType<typeof getStats>> | null = null;
  let statsError = '';
  try {
    stats = await getStats(poll.id);
  } catch (error) {
    statsError = getErrorMessage(error);
  }
  try {
    const voteStatus = await getVoteStatus(poll.id, hash);
    hasVoted ||= voteStatus.voted;
    if (voteStatus.voted) markVotedLocally(poll.id, hash);
  } catch (error) {
    voteStatusError = getErrorMessage(error);
  }
  let commentsContent: string;
  try {
    commentsContent = renderCommentsContent(poll.id, await getComments(poll.id, getQueryPage('commentsPage'), commentsPerPage));
  } catch {
    commentsContent = t('commentsLoadFailed');
  }
  const voteCounts = stats?.counts;
  const voteTotal = voteCounts
    ? voteCounts.approve + voteCounts.neutral + voteCounts.oppose
    : 0;
  const canComment = getCurrentUser() !== null;
  const voteButtons = voteCounts
    ? (['approve', 'neutral', 'oppose'] as const).map((option) => renderVoteButton(
      option,
      voteCounts[option],
      voteTotal,
      hasVoted || Boolean(voteStatusError),
      hasVoted ? t('alreadyVoted') : t(option)
    )).join('')
    : '';
  const alreadyReported = hasReportedLocally(poll.id);

  app.innerHTML = `
    <div class="mx-auto max-w-[var(--page-width)] px-5 pt-6 pb-16">
      ${renderHeader('/')}

      <main class="grid gap-5">
        <section class="rounded-[22px] border border-border bg-panel p-6 shadow-card">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span class="shrink-0 font-bold tabular-nums text-muted">#${poll.id}</span>
            <h1 class="m-0 text-2xl font-bold">${escapeHtml(poll.title)}</h1>
            ${renderModeBadge(poll.mode)}
          </div>

          ${poll.description ? `<p class="mt-3 mb-0 whitespace-pre-wrap text-muted">${escapeHtml(poll.description)}</p>` : ''}

          ${voteCounts ? `
            <div class="mx-auto mt-6 flex w-full max-w-[300px] overflow-hidden rounded-xl border border-border" role="group" aria-label="${t('vote')}" data-vote-group="${poll.id}" title="${hasVoted ? t('alreadyVoted') : ''}">
              ${voteButtons}
            </div>
          ` : stats?.hidden ? `
            <p class="mt-6 mb-0 text-center text-sm text-muted">${t('resultsHidden').replace('{n}', String(stats.threshold))}</p>
          ` : ''}

          ${turnstileSiteKey() ? '<div class="mx-auto mt-4 flex justify-center" data-turnstile-vote></div>' : ''}

          ${poll.mode === 'deadline' && poll.end_at
    ? `<p class="mt-3 mb-0 text-center text-xs text-muted" data-countdown data-end="${escapeHtml(poll.end_at)}"></p>`
    : ''}

          <p class="vote-status m-0 text-center text-muted" role="status">${voteStatusError
    ? `${t('voteStatusFailed')} ${voteStatusError}`
    : statsError
      ? `${t('statsLoadFailed')} ${statsError}`
    : ''}</p>
          <small class="mt-3.5 block text-center text-xs text-muted">${t('privacyText')}</small>
        </section>

        <section class="grid gap-3 rounded-[22px] border border-border bg-panel p-6 shadow-card">
          ${canComment ? `
            <button class="mx-auto cursor-pointer rounded-full border border-primary bg-primary px-4 py-2.5 text-white" type="button" aria-expanded="false" aria-controls="comment-form" data-toggle-comment>${t('commentToggle')}</button>
            <div class="grid gap-3" id="comment-form" hidden>
              <label for="comment">${t('accountComment')}</label>
              <textarea class="w-full resize-y rounded-[14px] border border-border bg-[#f9fbff] px-3.5 py-3" id="comment" minlength="5" maxlength="140" rows="4" placeholder="${t('commentPlaceholder')}"></textarea>
              <button class="mx-auto cursor-pointer rounded-full border border-primary bg-primary px-4 py-2.5 text-white" type="button" data-submit-comment>${t('submitComment')}</button>
              <p class="comment-submit-status m-0 min-h-5 text-[0.9rem] text-muted" role="status" aria-live="polite"></p>
            </div>
          ` : `
            <p class="m-0 text-center text-muted">${t('commentLoginRequired')}</p>
            <a class="mx-auto cursor-pointer rounded-full border border-primary bg-primary px-4 py-2.5 text-white no-underline" href="/login" data-route="/login">${t('loginRequiredAction')}</a>
          `}
        </section>

        <section class="rounded-[22px] border border-border bg-panel p-6 shadow-card">
          <h2 class="mb-3.5 text-xl font-bold">${t('commentsTitle')}</h2>
          <div id="comments-content">${commentsContent}</div>
        </section>

        <section class="rounded-[22px] border border-border bg-panel p-6 shadow-card" data-report-root>
          <p class="m-0 text-center text-sm text-muted" data-report-already ${alreadyReported ? '' : 'hidden'}>${t('reportAlreadySent')}</p>
          <div class="text-center" data-report-collapsed ${alreadyReported ? 'hidden' : ''}>
            <button class="cursor-pointer text-sm text-primary hover:underline" type="button" data-report-toggle>${t('reportLink')}</button>
          </div>
          <form class="grid gap-3" data-report-form hidden>
            <h2 class="m-0 text-lg font-bold">${t('reportTitle')}</h2>
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
            <button class="mx-auto cursor-pointer rounded-full border border-primary bg-primary px-4 py-2.5 text-white disabled:cursor-not-allowed disabled:opacity-60" type="button" data-report-submit disabled>${t('reportSubmit')}</button>
            <button class="mx-auto cursor-pointer text-sm text-muted hover:text-primary" type="button" data-report-cancel>${t('reportCancel')}</button>
            <p class="m-0 min-h-5 text-center text-[0.9rem] text-muted" role="status" aria-live="polite" data-report-status></p>
          </form>
        </section>
      </main>
      ${renderToast()}
      ${renderFooter()}
    </div>
  `;

  const commentToggle = document.querySelector<HTMLButtonElement>('[data-toggle-comment]');
  const commentForm = document.querySelector<HTMLDivElement>('#comment-form');
  const commentButton = document.querySelector<HTMLButtonElement>('[data-submit-comment]');
  const commentInput = document.querySelector<HTMLTextAreaElement>('#comment');
  const commentStatus = document.querySelector('.comment-submit-status');
  commentToggle?.addEventListener('click', () => {
    if (!commentToggle || !commentForm) return;
    const expanded = commentToggle.getAttribute('aria-expanded') === 'true';
    commentToggle.setAttribute('aria-expanded', String(!expanded));
    commentForm.hidden = expanded;
    if (!expanded) commentInput?.focus();
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
      window.history.replaceState({}, '', `/poll/${poll.id}?commentsPage=1`);
      await updateComments(poll.id, 1, bindNavigation);
    } catch (error) {
      if (commentStatus) commentStatus.textContent = `${t('commentSubmitFailed')} ${getErrorMessage(error)}`;
    } finally {
      commentButton.disabled = false;
    }
  });

  document.querySelectorAll<HTMLButtonElement>('[data-option]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (hasVoted || voteStatusError || statsError) return;
      const option = button.getAttribute('data-option') as 'approve' | 'oppose' | 'neutral';
      let result;
      try {
        result = await submitVote({
          pollId: poll.id,
          tokenHash: hash,
          option,
          turnstileToken: turnstileToken('vote')
        });
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        // A 503 means the deployment is missing its server key (or is in
        // read-only mode). Show a clear localized message instead of the terse
        // server text so a misconfiguration does not look like a client error.
        let statusMessage = errorMessage.includes('(503)')
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
          document.querySelectorAll<HTMLButtonElement>('[data-option]').forEach((voteButton) => {
            voteButton.disabled = true;
          });
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
        return;
      }
      resetTurnstile('vote');

      const statusText = option === 'approve' ? t('approve') : option === 'oppose' ? t('oppose') : t('neutral');
      const message = `${t('voteRecord')}: ${statusText}`;
      if (result.ok) {
        const voteGroup = document.querySelector<HTMLElement>(`[data-vote-group="${poll.id}"]`);
        if (voteGroup && result.counts) updateVoteGroup(voteGroup, result.counts);
        hasVoted = true;
        markVotedLocally(poll.id, hash);
        document.querySelectorAll<HTMLButtonElement>('[data-vote-group] [data-option]').forEach((voteButton) => {
          voteButton.disabled = true;
        });
        const choices = document.querySelector<HTMLElement>(`[data-vote-group="${poll.id}"]`);
        if (choices) choices.setAttribute('title', t('alreadyVoted'));
      }
      showToast(message, result.ok ? 'success' : 'error');
    });
  });

  // Countdown for deadline polls, refreshed once a minute.
  const countdown = document.querySelector<HTMLElement>('[data-countdown]');
  if (countdown) {
    const end = Date.parse(countdown.dataset.end ?? '');
    const renderCountdown = () => {
      if (!Number.isFinite(end)) return;
      const remaining = end - Date.now();
      if (remaining <= 0) {
        countdown.textContent = t('pollEnded');
        clearInterval(timer);
        return;
      }
      const days = Math.floor(remaining / 86_400_000);
      const hours = Math.floor((remaining % 86_400_000) / 3_600_000);
      const minutes = Math.floor((remaining % 3_600_000) / 60_000);
      countdown.textContent = `${t('timeRemaining')}: ${days}d ${hours}h ${minutes}m`;
    };
    const timer = setInterval(renderCountdown, 60_000);
    renderCountdown();
  }

  // Render the Turnstile widget on the vote area when a site key is configured.
  const voteWidget = document.querySelector<HTMLElement>('[data-turnstile-vote]');
  if (voteWidget) await renderTurnstile('vote', voteWidget);

  // Report form: opens inline, reveals the note field only for "Other", and
  // remembers a submitted report in localStorage so the link is replaced.
  const reportForm = document.querySelector<HTMLFormElement>('[data-report-form]');
  const reportToggle = document.querySelector<HTMLButtonElement>('[data-report-toggle]');
  const reportCollapsed = document.querySelector<HTMLElement>('[data-report-collapsed]');
  const reportAlready = document.querySelector<HTMLElement>('[data-report-already]');
  const reportSubmit = document.querySelector<HTMLButtonElement>('[data-report-submit]');
  const reportCancel = document.querySelector<HTMLButtonElement>('[data-report-cancel]');
  const reportNoteWrap = document.querySelector<HTMLElement>('[data-report-note-wrap]');
  const reportNote = document.querySelector<HTMLTextAreaElement>('[data-report-note]');
  const reportNoteCount = document.querySelector<HTMLElement>('[data-report-note-count]');
  const reportStatus = document.querySelector<HTMLElement>('[data-report-status]');
  const reportRadios = Array.from(document.querySelectorAll<HTMLInputElement>('[data-report-reason]'));

  const selectedReportReason = (): ReportReason | null => {
    const checked = reportRadios.find((radio) => radio.checked);
    return checked ? checked.value as ReportReason : null;
  };
  const updateReportNoteVisibility = () => {
    const isOther = selectedReportReason() === 'other';
    if (reportNoteWrap) reportNoteWrap.hidden = !isOther;
    if (!isOther && reportNote) reportNote.value = '';
    if (reportNoteCount) reportNoteCount.textContent = String(reportNote?.value.length ?? 0);
  };

  reportToggle?.addEventListener('click', async () => {
    if (reportCollapsed) reportCollapsed.hidden = true;
    if (reportForm) reportForm.hidden = false;
    const widget = document.querySelector<HTMLElement>('[data-turnstile-report]');
    if (widget) await renderTurnstile('report', widget);
  });
  reportCancel?.addEventListener('click', () => {
    if (reportForm) {
      reportForm.hidden = true;
      reportForm.reset();
    }
    if (reportStatus) reportStatus.textContent = '';
    if (reportNoteWrap) reportNoteWrap.hidden = true;
    if (reportSubmit) reportSubmit.disabled = true;
    if (reportCollapsed) reportCollapsed.hidden = false;
    resetTurnstile('report');
  });
  reportRadios.forEach((radio) => radio.addEventListener('change', () => {
    if (reportSubmit) reportSubmit.disabled = selectedReportReason() === null;
    updateReportNoteVisibility();
  }));
  reportNote?.addEventListener('input', () => {
    if (reportNoteCount) reportNoteCount.textContent = String(reportNote.value.length);
  });
  reportSubmit?.addEventListener('click', async () => {
    const reason = selectedReportReason();
    if (!reason) return;
    reportSubmit.disabled = true;
    if (reportStatus) reportStatus.textContent = '';
    try {
      await submitReport({
        pollId: poll.id,
        reason,
        note: reason === 'other' ? (reportNote?.value.trim() ?? '') : undefined,
        turnstileToken: turnstileToken('report')
      });
      markReportedLocally(poll.id);
      if (reportForm) reportForm.hidden = true;
      if (reportCollapsed) reportCollapsed.hidden = true;
      if (reportAlready) reportAlready.hidden = false;
      showToast(t('reportThanks'));
    } catch (error) {
      if (reportStatus) reportStatus.textContent = `${t('submitFailed')}: ${getErrorMessage(error)}`;
      reportSubmit.disabled = false;
      resetTurnstile('report');
    }
  });

  bindNavigation();
}
