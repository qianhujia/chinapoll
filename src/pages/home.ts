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
  getPollsPerPage,
  renderFooter,
  renderHeader,
  renderModeBadge,
  renderPagination,
  renderVoteButton,
  t,
  updateVoteGroup
} from '../ui';

export async function mountHome(app: HTMLElement, page: number, bindNavigation: () => void, settings?: Record<string, any>): Promise<void> {
  const pollsPerPage = getPollsPerPage();
  let issueStats: Awaited<ReturnType<typeof getIssues>>['issues'];
  let totalIssues: number;
  let totalVotes: number;
  try {
    const response = await getIssues(page, pollsPerPage);
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

  const totalPages = Math.max(1, Math.ceil(totalIssues / pollsPerPage));
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

  const heroTitle = settings?.hero_title || t('heroTitle');
  const heroSubtitle = settings?.hero_subtitle || t('heroBody');
  const heroBackgroundColor = settings?.hero_background_color || '';
  const hasHeroBackground = heroBackgroundColor !== '';
  const heroBackgroundStyle = hasHeroBackground ? `background: ${heroBackgroundColor};` : '';
  const heroTextClass = hasHeroBackground ? 'text-white' : 'text-ink';
  const heroSubtleClass = hasHeroBackground ? 'text-white/70' : 'text-muted';
  const heroCtaClass = hasHeroBackground
    ? 'border-white text-white hover:bg-white/10'
    : 'border-primary text-primary hover:bg-primary-soft';
  const heroDividerClass = hasHeroBackground ? 'bg-white/25' : 'bg-border';
  const openPollsCount = issueStats.filter(({ issue }) => Number(issue.status) === 1).length;

  app.innerHTML = `
    <div class="mx-auto max-w-[var(--page-width)] px-5 pt-6">
      ${renderHeader('/')}
    </div>

    <section class="relative flex min-h-[340px] max-[700px]:min-h-[300px] flex-col items-center justify-center overflow-hidden text-center px-5 py-14 max-[700px]:py-10 ${heroTextClass}"
      style="${heroBackgroundStyle}">
      <div class="relative z-10 flex flex-col items-center">
        <h1 class="m-0 text-[clamp(2rem,5vw,3.5rem)] leading-[1.1] font-bold text-balance">${escapeHtml(heroTitle)}</h1>
        <p class="mt-4 mb-8 text-[clamp(1rem,2.5vw,1.25rem)] leading-[1.5] max-w-2xl mx-auto ${heroSubtleClass}">${escapeHtml(heroSubtitle)}</p>
        <div class="flex flex-wrap items-center justify-center gap-3 mb-10 max-[700px]:mb-8">
          <a class="rounded-full border-2 bg-transparent px-6 py-3 font-medium transition-colors ${heroCtaClass}" href="/submit" data-route="/submit">${t('ctaSubmitIssues')}</a>
          <a class="rounded-full border-2 bg-transparent px-6 py-3 font-medium transition-colors ${heroCtaClass}" href="/about" data-route="/about">${t('ctaAnonymousRules')}</a>
        </div>
        <dl class="m-0 flex items-stretch justify-center gap-10 max-[700px]:gap-6">
          <div class="flex flex-col items-center gap-1">
            <dt class="order-2 text-[13px] leading-[1.4] font-medium ${heroSubtleClass}">${t('totalIssues')}</dt>
            <dd class="order-1 m-0 text-3xl leading-[1.1] font-bold">${totalIssues}</dd>
          </div>
          <div class="w-px ${heroDividerClass}" aria-hidden="true"></div>
          <div class="flex flex-col items-center gap-1">
            <dt class="order-2 text-[13px] leading-[1.4] font-medium ${heroSubtleClass}">${t('openPolls')}</dt>
            <dd class="order-1 m-0 text-3xl leading-[1.1] font-bold">${openPollsCount}</dd>
          </div>
          <div class="w-px ${heroDividerClass}" aria-hidden="true"></div>
          <div class="flex flex-col items-center gap-1">
            <dt class="order-2 text-[13px] leading-[1.4] font-medium ${heroSubtleClass}">${t('totalVotesCount')}</dt>
            <dd class="order-1 m-0 text-3xl leading-[1.1] font-bold" data-total-votes>${totalVotes}</dd>
          </div>
        </dl>
      </div>
    </section>

    <div class="mx-auto max-w-[var(--page-width)] px-5 pt-6 pb-16">
      <main class="grid gap-5">
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
