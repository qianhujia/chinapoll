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
  let openPolls: number;
  let totalPolls: number;
  let totalVotes: number;
  try {
    const response = await getPolls(page, pollsPerPage);
    pollStats = response.polls;
    openPolls = response.total;
    totalPolls = response.totalPolls;
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

  const totalPages = Math.max(1, Math.ceil(openPolls / pollsPerPage));
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
  const primaryCtaClass = hasHeroBackground
    ? 'bg-white text-ink hover:bg-white/90'
    : 'bg-primary text-white hover:opacity-90';
  const secondaryCtaClass = hasHeroBackground
    ? 'border border-white/60 text-white hover:bg-white/10'
    : 'border border-border bg-panel text-ink hover:border-primary hover:text-primary';
  const openPollsCount = openPolls;

  app.innerHTML = `
    <div class="mx-auto max-w-[var(--page-width)] px-5 pt-6">
      ${renderHeader('/')}
    </div>

    <section class="relative px-5 pt-10 pb-12 max-[700px]:pt-6 max-[700px]:pb-8 ${heroTextClass}" style="${heroBackgroundStyle}">
      <div class="mx-auto flex max-w-[var(--page-width)] flex-col items-center text-center">
        <h1 class="m-0 max-w-[22ch] text-[clamp(1.875rem,4vw,2.75rem)] leading-[1.15] font-extrabold tracking-[-0.02em] text-balance max-[700px]:max-w-none">${escapeHtml(heroTitle)}</h1>
        <p class="m-0 mt-4 max-w-2xl text-[clamp(0.95rem,1.8vw,1.1rem)] leading-[1.5] ${heroSubtleClass}">${escapeHtml(heroSubtitle)}</p>
        <div class="mt-6 flex flex-wrap items-center justify-center gap-3">
          <a class="rounded-lg px-6 py-2.5 text-sm transition-all ${primaryCtaClass}" href="/submit" data-route="/submit">${t('ctaSubmitPolls')}</a>
          <a class="rounded-lg px-6 py-2.5 text-sm transition-colors ${secondaryCtaClass}" href="/about" data-route="/about">${t('ctaAnonymousRules')}</a>
        </div>

        <dl class="m-0 mt-12 flex flex-wrap items-start justify-center gap-x-16 gap-y-8 max-[700px]:mt-8 max-[700px]:gap-x-10">
          <div class="flex min-w-[110px] flex-col items-center gap-2">
            <dd class="order-1 m-0 text-[clamp(2rem,4vw,2.75rem)] leading-none tracking-[-0.02em] tabular-nums">${totalPolls}</dd>
            <dt class="order-2 text-sm font-medium ${heroSubtleClass}">${t('totalPolls')}</dt>
          </div>
          <div class="flex min-w-[110px] flex-col items-center gap-2">
            <dd class="order-1 m-0 text-[clamp(2rem,4vw,2.75rem)] leading-none tracking-[-0.02em] tabular-nums">${openPollsCount}</dd>
            <dt class="order-2 text-sm font-medium ${heroSubtleClass}">${t('openPolls')}</dt>
          </div>
          <div class="flex min-w-[110px] flex-col items-center gap-2">
            <dd class="order-1 m-0 text-[clamp(2rem,4vw,2.75rem)] leading-none tracking-[-0.02em] tabular-nums" data-total-votes>${totalVotes}</dd>
            <dt class="order-2 text-sm font-medium ${heroSubtleClass}">${t('totalVotesCount')}</dt>
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
