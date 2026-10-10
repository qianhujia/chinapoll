import {
  createToken,
  getPolls,
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
  getSiteSlogan,
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
  let pollStats: Awaited<ReturnType<typeof getPolls>>['polls'];
  let totalPolls: number;
  let totalVotes: number;
  try {
    const response = await getPolls(page, pollsPerPage);
    pollStats = response.polls;
    totalPolls = response.total;
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

  const totalPages = Math.max(1, Math.ceil(totalPolls / pollsPerPage));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const tokenHash = await hashToken(createToken());
  const pollVoteStates = new Map<number, { voted: boolean; error: string }>();
  await Promise.all(pollStats.map(async ({ poll }) => {
    let voted = hasVotedLocally(poll.id, tokenHash);
    let error = '';
    try {
      const status = await getVoteStatus(poll.id, tokenHash);
      voted ||= status.voted;
      if (status.voted) markVotedLocally(poll.id, tokenHash);
    } catch (statusError) {
      error = getErrorMessage(statusError);
    }
    pollVoteStates.set(poll.id, { voted, error });
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
  const openPollsCount = pollStats.filter(({ poll }) => Number(poll.status) === 1).length;

  app.innerHTML = `
    <div class="mx-auto max-w-[var(--page-width)] px-5 pt-6">
      ${renderHeader('/')}
    </div>

    <section class="relative flex min-h-[340px] max-[700px]:min-h-[300px] flex-col items-center justify-center overflow-hidden text-center px-5 py-14 max-[700px]:py-10 ${heroTextClass}"
      style="${heroBackgroundStyle}">
      <div class="relative z-10 flex flex-col items-center">
        <p class="m-0 mb-3 text-sm font-semibold tracking-[0.2em] uppercase ${heroSubtleClass}">${escapeHtml(getSiteSlogan())}</p>
        <h1 class="m-0 text-[clamp(2rem,5vw,3.5rem)] leading-[1.1] font-bold text-balance">${escapeHtml(heroTitle)}</h1>
        <p class="mt-4 mb-8 text-[clamp(1rem,2.5vw,1.25rem)] leading-[1.5] max-w-2xl mx-auto ${heroSubtleClass}">${escapeHtml(heroSubtitle)}</p>
        <div class="flex flex-wrap items-center justify-center gap-3 mb-10 max-[700px]:mb-8">
          <a class="rounded-full border bg-transparent px-5 py-2 font-medium transition-colors ${heroCtaClass}" href="/submit" data-route="/submit">${t('ctaSubmitPolls')}</a>
          <a class="rounded-full border bg-transparent px-5 py-2 font-medium transition-colors ${heroCtaClass}" href="/about" data-route="/about">${t('ctaAnonymousRules')}</a>
        </div>
        <dl class="m-0 flex items-stretch justify-center gap-10 max-[700px]:gap-6">
          <div class="flex flex-col items-center gap-1">
            <dt class="order-2 text-[13px] leading-[1.4] font-medium ${heroSubtleClass}">${t('totalPolls')}</dt>
            <dd class="order-1 m-0 text-3xl leading-[1.1] font-bold">${totalPolls}</dd>
          </div>
          <div class="flex flex-col items-center gap-1">
            <dt class="order-2 text-[13px] leading-[1.4] font-medium ${heroSubtleClass}">${t('openPolls')}</dt>
            <dd class="order-1 m-0 text-3xl leading-[1.1] font-bold">${openPollsCount}</dd>
          </div>
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
          ${pollStats.length === 0
    ? `<p class="py-6 text-center text-muted">${t('noPolls')}</p>`
    : pollStats.map(({ poll, stats }) => {
            const total = stats.counts.approve + stats.counts.oppose + stats.counts.neutral;
            const voteState = pollVoteStates.get(poll.id) ?? { voted: false, error: '' };
            const voteDisabled = voteState.voted || Boolean(voteState.error);
            return `
              <article class="grid grid-cols-[minmax(0,1fr)_minmax(190px,240px)] items-center gap-x-8 border-b border-border py-[22px] max-[700px]:grid-cols-1 max-[700px]:gap-y-3" data-poll-row="${poll.id}">
                <div class="col-start-1 flex items-start justify-between gap-[18px]">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="shrink-0 font-bold tabular-nums text-muted">#${poll.id}</span>
                    <h2 class="m-0 flex-[1_1_auto] text-[1.15rem] leading-[1.5]"><a class="text-inherit no-underline hover:text-primary hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary" href="/poll/${poll.id}" data-route="/poll/${poll.id}">${escapeHtml(poll.title)}</a></h2>
                    ${renderModeBadge(poll.mode)}
                  </div>
                </div>

                <div class="col-start-2 row-start-1 flex items-center justify-center gap-5 max-[700px]:col-start-1">
                  <span class="shrink-0 whitespace-nowrap text-xs leading-[1.2] text-muted" data-home-total="${poll.id}">${total} ${t('votes')}</span>
                  <div class="flex w-full max-w-[300px] overflow-hidden rounded-xl border border-border max-[700px]:col-start-1" role="group" aria-label="${t('vote')}" data-vote-group="${poll.id}">
                    ${(['approve', 'neutral', 'oppose'] as const).map((option) => renderVoteButton(
                      option,
                      stats.counts[option],
                      total,
                      voteDisabled,
                      voteState.voted ? t('alreadyVoted') : voteState.error || t(option),
                      poll.id
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
      const pollId = Number(button.dataset.pollId);
      const option = button.dataset.option as VoteOption;
      const state = pollVoteStates.get(pollId);
      const pollStatsEntry = pollStats.find(({ poll }) => poll.id === pollId);
      if (!state || !pollStatsEntry || state.voted || state.error) return;

      const pollButtons = document.querySelectorAll<HTMLButtonElement>(`[data-home-vote][data-poll-id="${pollId}"]`);
      pollButtons.forEach((voteButton) => { voteButton.disabled = true; });

      try {
        const result = await submitVote({ pollId, tokenHash, option });
        if (!result.ok) throw new Error(result.message);

        pollStatsEntry.stats.counts = result.counts;
        state.voted = true;
        markVotedLocally(pollId, tokenHash);
        const pollTotal = result.counts.approve + result.counts.oppose + result.counts.neutral;
        totalVotes += 1;
        const totalVotesElement = document.querySelector('[data-total-votes]');
        if (totalVotesElement) totalVotesElement.textContent = String(totalVotes);
        const pollTotalElement = document.querySelector(`[data-home-total="${pollId}"]`);
        if (pollTotalElement) pollTotalElement.textContent = `${pollTotal} ${t('votes')}`;
        const voteGroup = document.querySelector<HTMLElement>(`[data-vote-group="${pollId}"]`);
        if (voteGroup) updateVoteGroup(voteGroup, result.counts);
        showToast(`${t('voteRecord')}: ${t(option)} ✅`);
      } catch (error) {
        let alreadyVoted = false;
        let message = `${t('submitFailed')}: ${getErrorMessage(error)}`;
        try {
          const currentStatus = await getVoteStatus(pollId, tokenHash);
          if (currentStatus.voted) {
            alreadyVoted = true;
            state.voted = true;
            markVotedLocally(pollId, tokenHash);
            message = t('alreadyVoted');
          }
        } catch {
          // Keep the original submission error if the follow-up status check fails.
        }
        showToast(message);
        if (!alreadyVoted) pollButtons.forEach((voteButton) => { voteButton.disabled = false; });
      }
    });
  });
}
