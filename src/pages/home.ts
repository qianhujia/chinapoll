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
  getQueryValue,
  renderFooter,
  renderHeader,
  renderModeBadge,
  renderPagination,
  renderPollTypeBadge,
  renderToast,
  renderVoteGroup,
  selectVoteOption,
  showToast,
  t,
  updateVoteGroup,
  viewIconMarkup
} from '../ui';

export async function mountHome(app: HTMLElement, page: number, bindNavigation: () => void, settings?: Record<string, any>): Promise<void> {
  const pollsPerPage = getPollsPerPage();
  const searchQuery = getQueryValue('q');
  let pollStats: Awaited<ReturnType<typeof getPolls>>['polls'];
  let openPolls: number;
  let totalPolls: number;
  let totalVotes: number;
  try {
    const response = await getPolls(page, pollsPerPage, searchQuery);
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
  const pollVoteStates = new Map<number, { voted: boolean; error: string; option: VoteOption | null }>();
  await Promise.all(pollStats.map(async ({ poll }) => {
    let voted = hasVotedLocally(poll.id, tokenHash);
    let error = '';
    let option: VoteOption | null = null;
    try {
      const status = await getVoteStatus(poll.id, tokenHash);
      voted ||= status.voted;
      if (status.voted) {
        markVotedLocally(poll.id, tokenHash);
        // Restore the chosen verdict so a returning voter sees it highlighted
        // even while the counts are hidden below the display threshold.
        option = status.option;
      }
    } catch (statusError) {
      error = getErrorMessage(statusError);
    }
    pollVoteStates.set(poll.id, { voted, error, option });
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
  const showHero = currentPage === 1 && searchQuery === '';

  app.innerHTML = `
    <div class="mx-auto max-w-[var(--page-width)] px-5 pt-6">
      ${renderHeader('/')}
    </div>

    ${showHero ? `
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
            <dt class="order-2 text-xs font-normal ${heroSubtleClass}">${t('totalPolls')}</dt>
          </div>
          <div class="flex min-w-[110px] flex-col items-center gap-2">
            <dd class="order-1 m-0 text-[clamp(2rem,4vw,2.75rem)] leading-none tracking-[-0.02em] tabular-nums">${openPollsCount}</dd>
            <dt class="order-2 text-xs font-normal ${heroSubtleClass}">${t('openPolls')}</dt>
          </div>
          <div class="flex min-w-[110px] flex-col items-center gap-2">
            <dd class="order-1 m-0 text-[clamp(2rem,4vw,2.75rem)] leading-none tracking-[-0.02em] tabular-nums" data-total-votes>${totalVotes}</dd>
            <dt class="order-2 text-xs font-normal ${heroSubtleClass}">${t('totalVotesCount')}</dt>
          </div>
        </dl>
      </div>
    </section>` : ''}

    <div class="mx-auto max-w-[var(--page-width)] px-5 pt-6 pb-16">
      <main class="grid gap-5">
        ${searchQuery
    ? `<div class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-panel px-4 py-3 text-sm">
            <span class="text-muted">${t('searchResultsFor')}: <strong class="text-ink">${escapeHtml(searchQuery)}</strong> · ${openPolls}</span>
            <a class="text-primary hover:underline" href="/" data-route="/">${t('searchClear')}</a>
          </div>`
    : ''}
        <section class="border-t border-border">
          ${pollStats.length === 0
    ? `<p class="py-6 text-center text-muted">${searchQuery ? t('searchNoResults') : t('noPolls')}</p>`
    : pollStats.map(({ poll, stats, views }) => {
            const counts = stats.counts;
            const pollType = poll.pollType ?? stats.pollType ?? 'verdict';
            const isChoice = pollType !== 'verdict';
            const verdictCounts = !isChoice && counts && 'approve' in counts ? counts : null;
            const total = verdictCounts ? verdictCounts.approve + verdictCounts.oppose + verdictCounts.neutral : 0;
            const voteState = pollVoteStates.get(poll.id) ?? { voted: false, error: '', option: null };
            // Voting is disabled only for a visitor who has already voted or
            // whose vote status could not be read. The display threshold hides
            // results; it never disables the buttons.
            const voteDisabled = voteState.voted || Boolean(voteState.error);
            const resultsHidden = stats.hidden === true;
            // The threshold notice replaces the vote total, not the buttons.
            const voteTotalLine = resultsHidden
              ? `<span class="shrink-0 whitespace-nowrap text-xs leading-[1.2] text-muted">${t('resultsHidden').replace('{n}', String(stats.threshold))}</span>`
              : `<span class="shrink-0 whitespace-nowrap text-xs leading-[1.2] text-muted" data-home-total="${poll.id}">${total} ${isChoice ? t('ballots') : t('votes')}</span>`;
            return `
              <article class="grid grid-cols-[minmax(0,1fr)_minmax(190px,240px)] items-center gap-x-8 border-b border-border py-[22px] max-[700px]:grid-cols-1 max-[700px]:gap-y-3" data-poll-row="${poll.id}">
                <div class="col-start-1 flex items-start justify-between gap-[18px]">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="shrink-0 font-bold tabular-nums text-muted">#${poll.id}</span>
                    <h2 class="m-0 flex-[1_1_auto] text-[1.15rem] leading-[1.5]"><a class="text-inherit no-underline hover:text-primary hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary" href="/poll/${poll.id}" data-route="/poll/${poll.id}">${escapeHtml(poll.title)}</a></h2>
                    ${renderModeBadge(poll.mode)}
                    ${renderPollTypeBadge(pollType, poll.options?.length ?? 0)}
                  </div>
                </div>

                <div class="col-start-2 row-start-1 flex items-center justify-center gap-5 max-[700px]:col-start-1">
                  ${voteTotalLine}
                  ${views ? `<span class="inline-flex shrink-0 items-center gap-1 text-xs leading-[1.2] text-muted" title="${t('views')}">${viewIconMarkup('h-3.5 w-3.5')}${views.total}</span>` : ''}
                  ${isChoice
                    ? `<a class="shrink-0 whitespace-nowrap rounded-full border border-border bg-panel px-3 py-1.5 text-xs text-ink no-underline hover:border-primary hover:text-primary max-[700px]:col-start-1" href="/poll/${poll.id}" data-route="/poll/${poll.id}">${t('vote')}</a>`
                    : renderVoteGroup({
                      pollId: poll.id,
                      counts: resultsHidden ? null : verdictCounts,
                      hidden: resultsHidden,
                      disabled: voteDisabled,
                      title: voteState.voted ? t('alreadyVoted') : voteState.error || t('vote'),
                      selected: voteState.option ?? null,
                      homePage: true
                    })}
                </div>
              </article>
            `;
          }).join('')}
        </section>
        ${renderPagination(currentPage, totalPages, (targetPage) => searchQuery
    ? `/?q=${encodeURIComponent(searchQuery)}&page=${targetPage}`
    : `/?page=${targetPage}`)}
      </main>

      ${renderToast()}
      ${renderFooter()}
    </div>
  `;

  bindNavigation();
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
        pollStatsEntry.stats.hidden = result.hidden;
        state.voted = true;
        markVotedLocally(pollId, tokenHash);
        const counts = result.counts && 'approve' in result.counts ? result.counts : null;
        const pollTotal = counts ? counts.approve + counts.oppose + counts.neutral : 0;
        totalVotes += 1;
        const totalVotesElement = document.querySelector('[data-total-votes]');
        if (totalVotesElement) totalVotesElement.textContent = String(totalVotes);
        // Below the display threshold the numbers stay hidden: the chosen button
        // is marked as selected and the group is disabled instead.
        const voteGroup = document.querySelector<HTMLElement>(`[data-vote-group="${pollId}"]`);
        if (voteGroup) {
          selectVoteOption(voteGroup, option);
          updateVoteGroup(voteGroup, counts);
        }
        const pollTotalElement = document.querySelector(`[data-home-total="${pollId}"]`);
        if (pollTotalElement) pollTotalElement.textContent = counts ? `${pollTotal} ${t('votes')}` : '';
        showToast(`${t('voteRecord')}: ${t(option)}`);
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
        showToast(message, alreadyVoted ? 'success' : 'error');
        if (!alreadyVoted) pollButtons.forEach((voteButton) => { voteButton.disabled = false; });
      }
    });
  });
}
