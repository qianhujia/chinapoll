import {
  createToken,
  getComments,
  getPoll,
  getStats,
  getVoteStatus,
  hasVotedLocally,
  hashToken,
  markVotedLocally,
  submitComment,
  submitVote
} from '../lib/poll';
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

export async function mountVotePage(pollId: number, app: HTMLElement, bindNavigation: () => void): Promise<void> {
  const commentsPerPage = getCommentsPerPage();
  let poll;
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
  const hash = await hashToken(token);
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
  const voteButtons = voteCounts
    ? (['approve', 'neutral', 'oppose'] as const).map((option) => renderVoteButton(
      option,
      voteCounts[option],
      voteTotal,
      hasVoted || Boolean(voteStatusError),
      hasVoted ? t('alreadyVoted') : t(option)
    )).join('')
    : '';

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
          ` : ''}

          <p class="vote-status m-0 text-center text-muted" role="status">${voteStatusError
    ? `${t('voteStatusFailed')} ${voteStatusError}`
    : statsError
      ? `${t('statsLoadFailed')} ${statsError}`
    : ''}</p>
          <small class="mt-3.5 block text-center text-xs text-muted">${t('privacyText')}</small>
        </section>

        <section class="grid gap-3 rounded-[22px] border border-border bg-panel p-6 shadow-card">
          <button class="mx-auto cursor-pointer rounded-full border border-primary bg-primary px-4 py-2.5 text-white" type="button" aria-expanded="false" aria-controls="comment-form" data-toggle-comment>${t('commentToggle')}</button>
          <div class="grid gap-3" id="comment-form" hidden>
            <label for="comment">${t('anonymousComment')}</label>
            <textarea class="w-full resize-y rounded-[14px] border border-border bg-[#f9fbff] px-3.5 py-3" id="comment" minlength="5" maxlength="140" rows="4" placeholder="${t('commentPlaceholder')}"></textarea>
            <button class="mx-auto cursor-pointer rounded-full border border-primary bg-primary px-4 py-2.5 text-white" type="button" data-submit-comment>${t('submitComment')}</button>
            <p class="comment-submit-status m-0 min-h-5 text-[0.9rem] text-muted" role="status" aria-live="polite"></p>
          </div>
        </section>

        <section class="rounded-[22px] border border-border bg-panel p-6 shadow-card">
          <h2 class="mb-3.5 text-xl font-bold">${t('commentsTitle')}</h2>
          <div id="comments-content">${commentsContent}</div>
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
          option
        });
      } catch (error) {
        let statusMessage = `${t('submitFailed')}: ${getErrorMessage(error)}`;
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
        return;
      }

      const statusText = option === 'approve' ? t('approve') : option === 'oppose' ? t('oppose') : t('neutral');
      const message = `${t('voteRecord')}: ${statusText}`;
      if (result.ok) {
        const voteGroup = document.querySelector<HTMLElement>(`[data-vote-group="${poll.id}"]`);
        if (voteGroup) updateVoteGroup(voteGroup, result.counts);
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

  bindNavigation();
}
