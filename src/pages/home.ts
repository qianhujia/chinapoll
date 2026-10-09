import {
  createToken,
  getIssues,
  getVoteStatus,
  hasVotedLocally,
  hashToken,
  markVotedLocally,
  submitVote,
  type VoteOption
} from '../lib/poll';
import {
  escapeHtml,
  getErrorMessage,
  POLLS_PER_PAGE,
  renderFooter,
  renderHeader,
  renderModeBadge,
  renderPagination,
  renderVoteButton,
  t,
  updateVoteGroup
} from '../ui';

export async function mountHome(app: HTMLElement, page: number, bindNavigation: () => void): Promise<void> {
  let issueStats: Awaited<ReturnType<typeof getIssues>>['issues'];
  let totalIssues: number;
  let totalVotes: number;
  try {
    const response = await getIssues(page, POLLS_PER_PAGE);
    issueStats = response.issues;
    totalIssues = response.total;
    totalVotes = response.totalVotes;
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

  const totalPages = Math.max(1, Math.ceil(totalIssues / POLLS_PER_PAGE));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const tokenHash = await hashToken(createToken());
  const issueVoteStates = new Map<number, { voted: boolean; error: string }>();
  await Promise.all(issueStats.map(async ({ issue }) => {
    let voted = hasVotedLocally(issue.id, tokenHash);
    let error = '';
    try {
      const status = await getVoteStatus(issue.id, tokenHash);
      voted ||= status.voted;
      if (status.voted) markVotedLocally(issue.id, tokenHash);
    } catch (statusError) {
      error = getErrorMessage(statusError);
    }
    issueVoteStates.set(issue.id, { voted, error });
  }));

  app.innerHTML = `
    <div class="mx-auto max-w-[var(--page-width)] px-5 pt-6 pb-16">
      ${renderHeader('/')}

      <main class="grid gap-5">
        <section class="pt-7 pb-2">
          <h1 class="mb-2.5 text-[clamp(2rem,4vw,3rem)] leading-[1.1] font-bold">${t('heroTitle')}</h1>
          <p class="m-0 text-[1.05rem] text-muted">${t('heroBody')}</p>
        </section>

        <section class="grid grid-cols-3 gap-3 rounded-[22px] border border-border bg-panel p-6 shadow-card max-[700px]:grid-cols-1">
          <div>
            <span class="mb-1 block text-xs tracking-[0.08em] text-muted uppercase">${t('openPolls')}</span>
            <strong>${totalIssues}</strong>
          </div>
          <div>
            <span class="mb-1 block text-xs tracking-[0.08em] text-muted uppercase">${t('totalVotes')}</span>
            <strong data-total-votes>${totalVotes}</strong>
          </div>
          <div>
            <span class="mb-1 block text-xs tracking-[0.08em] text-muted uppercase">${t('modes')}</span>
            <strong>${t('deadline')} + ${t('evergreen')}</strong>
          </div>
        </section>

        <section class="border-t border-border">
          ${issueStats.length === 0
    ? `<p class="py-6 text-center text-muted">${t('noPolls')}</p>`
    : issueStats.map(({ issue, stats }) => {
            const total = stats.counts.approve + stats.counts.oppose + stats.counts.neutral;
            const voteState = issueVoteStates.get(issue.id) ?? { voted: false, error: '' };
            const voteDisabled = voteState.voted || Boolean(voteState.error);
            return `
              <article class="grid grid-cols-[minmax(0,1fr)_minmax(190px,240px)] items-center gap-x-8 border-b border-border py-[22px] max-[700px]:grid-cols-1 max-[700px]:gap-y-3" data-poll-row="${issue.id}">
                <div class="col-start-1 flex items-start justify-between gap-[18px]">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="shrink-0 font-bold tabular-nums text-muted">#${issue.id}</span>
                    <h2 class="m-0 flex-[1_1_auto] text-[1.15rem] leading-[1.5]"><a class="text-inherit no-underline hover:text-primary hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary" href="/poll/${issue.id}" data-route="/poll/${issue.id}">${escapeHtml(issue.title)}</a></h2>
                    ${renderModeBadge(issue.mode)}
                  </div>
                </div>

                <div class="col-start-2 row-start-1 flex items-center justify-center gap-5 max-[700px]:col-start-1">
                  <span class="shrink-0 whitespace-nowrap text-xs leading-[1.2] text-muted" data-home-total="${issue.id}">${total} ${t('votes')}</span>
                  <div class="flex w-full max-w-[300px] overflow-hidden rounded-xl border border-border max-[700px]:col-start-1" role="group" aria-label="${t('vote')}" data-vote-group="${issue.id}">
                    ${(['approve', 'neutral', 'oppose'] as const).map((option) => renderVoteButton(
                      option,
                      stats.counts[option],
                      total,
                      voteDisabled,
                      voteState.voted ? t('alreadyVoted') : voteState.error || t(option),
                      issue.id
                    )).join('')}
                  </div>
                </div>
              </article>
            `;
          }).join('')}
        </section>
        ${renderPagination(currentPage, totalPages, (targetPage) => `/?page=${targetPage}`)}
      </main>

      <div class="fixed top-5 left-1/2 z-10 max-w-[min(420px,calc(100vw-40px))] -translate-x-1/2 rounded-xl border border-border bg-panel px-[18px] py-3 text-ink shadow-card" data-home-toast role="status" aria-live="polite" hidden></div>
      ${renderFooter()}
    </div>
  `;

  bindNavigation();
  const toast = document.querySelector<HTMLElement>('[data-home-toast]');
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const showToast = (message: string) => {
    if (!toast) return;
    if (toastTimer) clearTimeout(toastTimer);
    toast.textContent = message;
    toast.hidden = false;
    toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, 3500);
  };
  document.querySelectorAll<HTMLButtonElement>('[data-home-vote]').forEach((button) => {
    button.addEventListener('click', async () => {
      const issueId = Number(button.dataset.issueId);
      const option = button.dataset.option as VoteOption;
      const state = issueVoteStates.get(issueId);
      const issueStatsEntry = issueStats.find(({ issue }) => issue.id === issueId);
      if (!state || !issueStatsEntry || state.voted || state.error) return;

      const issueButtons = document.querySelectorAll<HTMLButtonElement>(`[data-home-vote][data-issue-id="${issueId}"]`);
      issueButtons.forEach((voteButton) => { voteButton.disabled = true; });

      try {
        const result = await submitVote({ issueId, tokenHash, option });
        if (!result.ok) throw new Error(result.message);

        issueStatsEntry.stats.counts = result.counts;
        state.voted = true;
        markVotedLocally(issueId, tokenHash);
        const issueTotal = result.counts.approve + result.counts.oppose + result.counts.neutral;
        totalVotes += 1;
        const totalVotesElement = document.querySelector('[data-total-votes]');
        if (totalVotesElement) totalVotesElement.textContent = String(totalVotes);
        const issueTotalElement = document.querySelector(`[data-home-total="${issueId}"]`);
        if (issueTotalElement) issueTotalElement.textContent = `${issueTotal} ${t('votes')}`;
        const voteGroup = document.querySelector<HTMLElement>(`[data-vote-group="${issueId}"]`);
        if (voteGroup) updateVoteGroup(voteGroup, result.counts);
        showToast(`${t('voteRecord')}: ${t(option)} ✅`);
      } catch (error) {
        let alreadyVoted = false;
        let message = `${t('submitFailed')}: ${getErrorMessage(error)}`;
        try {
          const currentStatus = await getVoteStatus(issueId, tokenHash);
          if (currentStatus.voted) {
            alreadyVoted = true;
            state.voted = true;
            markVotedLocally(issueId, tokenHash);
            message = t('alreadyVoted');
          }
        } catch {
          // Keep the original submission error if the follow-up status check fails.
        }
        showToast(message);
        if (!alreadyVoted) issueButtons.forEach((voteButton) => { voteButton.disabled = false; });
      }
    });
  });
}
