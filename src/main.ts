import './styles.css';
import { getLocaleText, DEFAULT_LOCALE } from './i18n';
import { claimProposal, createToken, getComments, getStats, getVoteStatus, hasVotedLocally, hashToken, markVotedLocally, submitComment, submitProposal, submitVote, type CommentsResponse, type VoteOption } from './lib/poll';

const app = document.querySelector('#app');
const voteButtonStyles: Record<VoteOption, { color: string; empty: string }> = {
  approve: { color: '#1fa36a', empty: '#e7f5ed' },
  neutral: { color: '#7a8798', empty: '#edf0f4' },
  oppose: { color: '#d95b5b', empty: '#faeaea' }
};

function voteFillPath(percent: number): string {
  if (percent >= 100) return 'M0 0 H100 V100 H0 Z';
  const level = 100 - percent;
  return `M0 ${level} H100 V100 H0 Z`;
}

function renderVoteButton(
  option: VoteOption,
  count: number,
  total: number,
  disabled: boolean,
  title: string,
  homeIssueId?: number
): string {
  const style = voteButtonStyles[option];
  const label = t(option);
  const percent = total > 0 ? count / total * 100 : 0;
  const homeAttributes = homeIssueId === undefined
    ? ''
    : `data-home-vote data-issue-id="${homeIssueId}"`;

  return `
    <button
      type="button"
      class="relative flex min-w-0 flex-1 flex-wrap cursor-pointer items-center justify-center gap-x-1 gap-y-0.5 border-r border-border px-1 py-2 text-xs text-ink transition-[filter] hover:enabled:brightness-95 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-primary last:border-r-0 disabled:cursor-not-allowed disabled:opacity-[0.65]"
      style="background:${style.empty}"
      data-option="${option}"
      aria-label="${label}: ${count}"
      title="${title}"
      ${homeAttributes}
      ${disabled ? 'disabled' : ''}
    >
      <svg class="pointer-events-none absolute inset-0 h-full w-full" data-vote-fill="${option}" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <path d="${count > 0 ? voteFillPath(percent) : ''}" fill="${style.color}"></path>
      </svg>
      <span class="relative z-10 whitespace-nowrap">${label}</span>
      <span class="choice-count relative z-10 shrink-0 tabular-nums" data-vote-count="${option}">${count}</span>
    </button>
  `;
}

function updateVoteGroup(group: HTMLElement, counts: Record<VoteOption, number>): void {
  const total = counts.approve + counts.neutral + counts.oppose;
  for (const option of ['approve', 'neutral', 'oppose'] as const) {
    const button = group.querySelector<HTMLButtonElement>(`[data-option="${option}"]`);
    const countElement = button?.querySelector<HTMLElement>('[data-vote-count]');
    if (!button || !countElement) continue;

    const count = counts[option];
    const percent = total > 0 ? count / total * 100 : 0;
    const fillPath = button.querySelector<SVGPathElement>('[data-vote-fill] path');
    if (fillPath) fillPath.setAttribute('d', count > 0 ? voteFillPath(percent) : '');
    countElement.textContent = String(count);
    button.setAttribute('aria-label', `${t(option)}: ${count}`);
  }
}

const configuredPageWidth = import.meta.env.VITE_PAGE_WIDTH;
if (configuredPageWidth && /^\d{3,4}px$/.test(configuredPageWidth)) {
  document.documentElement.style.setProperty('--page-width', configuredPageWidth);
}

type PollIssue = {
  id: number;
  title: string;
  mode: 'deadline' | 'evergreen';
  start_at: string;
  end_at?: string | null;
  status: 'open' | 'closed' | 'archived';
};

const pollTitles = [
  '学校是否应开设必修数字素养课程？',
  '是否应建立统一的年度公众意见调查机制？',
  '公共预算是否应每月公开？',
  '重大社区事务是否应举行公开听证会？',
  '城市是否应按时段对道路拥堵收费？',
  '图书馆是否应延长晚间开放时间？',
  '政府数据 API 是否应公开变更记录？',
  '城市绿道是否应纳入统一维护计划？',
  '社区是否应对共享单车停放实施更严格的规定？',
  '公共交通线路数据是否应实时公开？',
  '研究生就业数据是否应每年公开？',
  '患者是否应能够查询自己的电子健康档案？',
  '社区意见征集平台是否应公开征集结果？',
  '政府网站是否应提供公民预算可视化信息？',
  '公共设施维护计划是否应每季度公开？',
  '地方教育资源是否应接受标准化评估？',
  '社区停车收入是否应透明公开？',
  '公共场所是否应加强无障碍反馈渠道？',
  '是否应利用区块链追踪食品供应链？',
  '地方政府是否应公开招标中标率数据？',
  '环境数据是否应采用统一的区域报告标准？',
  '学校是否应加强网络安全教育？',
  '公共服务满意度报告是否应每季度发布？',
  '社区公共空间是否应设置开放投票点？',
  '基础设施建设的详细支出是否应公开？',
  '公共活动风险评估是否应向公众公开？',
  '公共政策研究结果是否应接受第三方审计？',
  '地方政府债务风险简报是否应公开？',
  '医院是否应以更透明的方式公示价格？',
  '社区养老服务是否应接受公开评估？',
  '数字广告牌的设置是否应遵循更严格的透明规定？'
];

function t(key: string): string {
  return getLocaleText(DEFAULT_LOCALE, key);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getSiteName(): string {
  return import.meta.env.VITE_SITENAME || t('appName');
}

function getSiteSlogan(): string {
  return import.meta.env.VITE_SLOGON || t('tagline');
}

function renderHeader(activeRoute: string): string {
  return `
    <header class="flex items-center justify-between py-4 pb-5 max-[700px]:flex-col max-[700px]:items-start">
      <div class="flex flex-col gap-1">
        <a class="text-3xl font-extrabold leading-none text-primary hover:underline" href="/" data-route="/" aria-label="${t('homeLinkLabel')}">${getSiteName()}</a>
        <div class="text-sm text-muted">${getSiteSlogan()}</div>
      </div>
      <nav class="flex flex-wrap items-center gap-[18px]">
        ${getNavigationMarkup(activeRoute)}
      </nav>
    </header>
  `;
}

function renderFooter(): string {
  const dataUrl = import.meta.env.VITE_DATA_GITHUB_URL;

  return `
    <footer class="mt-9 flex flex-wrap items-center justify-center gap-3 text-center text-[0.9rem] text-muted">
      <span>Powered by <a class="font-bold text-primary hover:underline" href="https://github.com/qianhujia/chinapoll" target="_blank" rel="noopener noreferrer">${getSiteName()}</a></span>
      <a class="text-primary hover:underline" href="/submit/claim" data-route="/submit/claim">${t('claimProposalLink')}</a>
      ${dataUrl ? `<a class="text-primary hover:underline" href="${dataUrl}" target="_blank" rel="noopener noreferrer">${t('dataLink')}</a>` : ''}
    </footer>
  `;
}

function buildSampleIssues(): PollIssue[] {
  return Array.from({ length: 30 }, (_, index) => {
    const id = index + 11;
    const title = pollTitles[index] ?? '公共治理是否应更加透明？';
    const mode = id % 3 === 0 ? 'evergreen' : 'deadline';
    return {
      id,
      title,
      mode,
      start_at: '2026-10-01T09:00:00Z',
      end_at: mode === 'deadline' ? '2026-10-31T09:00:00Z' : null,
      status: 'open'
    };
  });
}

const sampleIssues = buildSampleIssues();

function configuredPageSize(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : fallback;
}

const POLLS_PER_PAGE = configuredPageSize(import.meta.env.VITE_POLLS_PER_PAGE, 15);
const COMMENTS_PER_PAGE = configuredPageSize(import.meta.env.VITE_COMMENTS_PER_PAGE, 30);

function getIssueById(issueId: number): PollIssue {
  return sampleIssues.find((issue) => issue.id === issueId) ?? sampleIssues[0];
}

function renderPagination(page: number, totalPages: number, attribute: string): string {
  if (totalPages <= 1) return '';

  return `
    <nav class="mt-5 flex items-center justify-center gap-4" aria-label="${t('pagination')}">
      <button class="cursor-pointer rounded-full px-4 py-2.5 text-ink hover:bg-primary-soft disabled:cursor-not-allowed disabled:opacity-50" ${attribute}="${page - 1}" ${page === 1 ? 'disabled' : ''}>${t('previousPage')}</button>
      <span>${t('pageOf')} ${page} / ${totalPages}</span>
      <button class="cursor-pointer rounded-full px-4 py-2.5 text-ink hover:bg-primary-soft disabled:cursor-not-allowed disabled:opacity-50" ${attribute}="${page + 1}" ${page === totalPages ? 'disabled' : ''}>${t('nextPage')}</button>
    </nav>
  `;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character] ?? character);
}

function renderCommentsContent(response: CommentsResponse): string {
  const totalPages = Math.ceil(response.total / response.pageSize);
  const comments = response.comments.length
    ? `<ul class="m-0 grid list-none gap-3.5 p-0">${response.comments.map(({ id, comment, createdAt }) => `
        <li class="border-b border-border py-3.5">
          <p class="mb-2 whitespace-pre-wrap [overflow-wrap:anywhere]">${escapeHtml(comment)}</p>
          <time class="text-xs text-muted" datetime="${escapeHtml(createdAt)}">${escapeHtml(createdAt)}</time>
        </li>
      `).join('')}</ul>`
    : `<p class="text-muted">${t('noComments')}</p>`;

  return `${comments}${renderPagination(response.page, totalPages, 'data-comments-page')}`;
}

async function updateComments(issueId: number, page: number): Promise<void> {
  const content = document.querySelector('#comments-content');
  if (!content) return;

  try {
    const response = await getComments(issueId, page, COMMENTS_PER_PAGE);
    content.innerHTML = renderCommentsContent(response);
    bindCommentPagination(issueId);
  } catch {
    content.textContent = t('commentsLoadFailed');
  }
}

function bindCommentPagination(issueId: number): void {
  document.querySelectorAll('[data-comments-page]').forEach((button) => {
    button.addEventListener('click', () => {
      const page = Number(button.getAttribute('data-comments-page'));
      if (Number.isSafeInteger(page) && page > 0) void updateComments(issueId, page);
    });
  });
}

function getCurrentRoute(): string {
  const hash = window.location.hash || '';
  const path = window.location.pathname || '/';

  if (hash.startsWith('#')) {
    const id = hash.slice(1).trim();
    if (id && /^[0-9]+$/.test(id)) {
      return `/poll/${id}`;
    }
  }

  return path === '' ? '/' : path;
}

function getNavigationMarkup(activeRoute: string): string {
  const links = [
    { route: '/', label: t('home') },
    { route: '/about', label: t('about') },
    { route: '/submit', label: t('propose') }
  ];

  return links.map(({ route, label }) => `
    <a class="py-1 text-muted no-underline hover:text-primary ${activeRoute === route ? 'font-bold text-primary' : ''}" href="${route}" data-route="${route}">${label}</a>
  `).join('');
}

async function mountHome(page = 1) {
  let issueStats: Array<{ issue: PollIssue; stats: Awaited<ReturnType<typeof getStats>> }>;
  try {
    issueStats = await Promise.all(sampleIssues.map(async (issue) => ({
      issue,
      stats: await getStats(issue.id)
    })));
  } catch (error) {
    app!.innerHTML = `
      <div class="mx-auto max-w-[var(--page-width)] px-5 pt-6 pb-16">
        ${renderHeader('/')}
        <main class="grid gap-5"><p class="m-0 text-center text-muted">${t('statsLoadFailed')} ${getErrorMessage(error)}</p></main>
        ${renderFooter()}
      </div>
    `;
    bindNavigation();
    return;
  }

  let totalVotes = issueStats.reduce((sum, { stats }) => {
    return sum + stats.counts.approve + stats.counts.oppose + stats.counts.neutral;
  }, 0);
  const totalPages = Math.ceil(issueStats.length / POLLS_PER_PAGE);
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const visibleIssueStats = issueStats.slice((currentPage - 1) * POLLS_PER_PAGE, currentPage * POLLS_PER_PAGE);
  const tokenHash = await hashToken(createToken());
  const issueVoteStates = new Map<number, { voted: boolean; error: string }>();
  await Promise.all(visibleIssueStats.map(async ({ issue }) => {
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

  app!.innerHTML = `
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
            <strong>${sampleIssues.length}</strong>
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
          ${visibleIssueStats.map(({ issue, stats }) => {
            const total = stats.counts.approve + stats.counts.oppose + stats.counts.neutral;
            const voteState = issueVoteStates.get(issue.id) ?? { voted: false, error: '' };
            const voteDisabled = voteState.voted || Boolean(voteState.error);
            return `
              <article class="grid grid-cols-[minmax(0,1fr)_minmax(190px,240px)] items-center gap-x-8 border-b border-border py-[22px] max-[700px]:grid-cols-1 max-[700px]:gap-y-3" data-poll-row="${issue.id}">
                <div class="col-start-1 flex items-start justify-between gap-[18px]">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="shrink-0 font-bold tabular-nums text-muted">#${issue.id}</span>
                    <span class="shrink-0 rounded-full bg-primary-soft px-[9px] py-[3px] text-xs leading-[1.5] whitespace-nowrap text-primary">${issue.mode === 'deadline' ? t('deadline') : t('evergreen')}</span>
                    <h2 class="m-0 flex-[1_1_auto] text-[1.15rem] leading-[1.5] font-bold"><a class="text-inherit no-underline hover:text-primary hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary" href="/poll/${issue.id}" data-route="/poll/${issue.id}">${issue.title}</a></h2>
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
        ${renderPagination(currentPage, totalPages, 'data-poll-page')}
      </main>

      <div class="fixed top-5 left-1/2 z-10 max-w-[min(420px,calc(100vw-40px))] -translate-x-1/2 rounded-xl border border-border bg-panel px-[18px] py-3 text-ink shadow-card" data-home-toast role="status" aria-live="polite" hidden></div>
      ${renderFooter()}
    </div>
  `;

  bindNavigation();
  document.querySelectorAll('[data-poll-page]').forEach((button) => {
    button.addEventListener('click', () => {
      const nextPage = Number(button.getAttribute('data-poll-page'));
      if (Number.isSafeInteger(nextPage) && nextPage > 0) void mountHome(nextPage);
    });
  });
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

async function mountVotePage(issueId: number) {
  const issue = getIssueById(issueId);
  const token = createToken();
  const hash = await hashToken(token);
  let hasVoted = hasVotedLocally(issue.id, hash);
  let voteStatus: Awaited<ReturnType<typeof getVoteStatus>> | null = null;
  let voteStatusError = '';
  let stats: Awaited<ReturnType<typeof getStats>> | null = null;
  let statsError = '';
  try {
    stats = await getStats(issue.id);
  } catch (error) {
    statsError = getErrorMessage(error);
  }
  try {
    voteStatus = await getVoteStatus(issue.id, hash);
    hasVoted ||= voteStatus.voted;
    if (voteStatus.voted) markVotedLocally(issue.id, hash);
  } catch (error) {
    voteStatusError = getErrorMessage(error);
  }
  let commentsContent: string;
  try {
    commentsContent = renderCommentsContent(await getComments(issue.id, 1, COMMENTS_PER_PAGE));
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

  app!.innerHTML = `
    <div class="mx-auto max-w-[var(--page-width)] px-5 pt-6 pb-16">
      ${renderHeader('/')}

      <main class="grid gap-5">
        <section class="rounded-[22px] border border-border bg-panel p-6 shadow-card">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span class="shrink-0 font-bold tabular-nums text-muted">#${issue.id}</span>
            <h1 class="m-0 text-2xl font-bold">${issue.title}</h1>
            <span class="shrink-0 rounded-full bg-primary-soft px-[9px] py-[3px] text-xs leading-[1.5] whitespace-nowrap text-primary">${issue.mode === 'deadline' ? t('deadline') : t('evergreen')}</span>
          </div>

          ${voteCounts ? `
            <div class="mx-auto mt-6 flex w-full max-w-[300px] overflow-hidden rounded-xl border border-border" role="group" aria-label="${t('vote')}" data-vote-group="${issue.id}" title="${hasVoted ? t('alreadyVoted') : ''}">
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
      ${renderFooter()}
    </div>
  `;

  const commentToggle = document.querySelector('[data-toggle-comment]') as HTMLButtonElement | null;
  const commentForm = document.querySelector('#comment-form') as HTMLDivElement | null;
  const commentButton = document.querySelector('[data-submit-comment]') as HTMLButtonElement | null;
  const commentInput = document.querySelector('#comment') as HTMLTextAreaElement | null;
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
      await submitComment(issue.id, comment);
      if (commentInput) commentInput.value = '';
      if (commentStatus) commentStatus.textContent = t('commentSubmitted');
      await updateComments(issue.id, 1);
    } catch (error) {
      if (commentStatus) commentStatus.textContent = `${t('commentSubmitFailed')} ${getErrorMessage(error)}`;
    } finally {
      commentButton.disabled = false;
    }
  });

  document.querySelectorAll('[data-option]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (hasVoted || voteStatusError || statsError) return;
      const option = button.getAttribute('data-option') as 'approve' | 'oppose' | 'neutral';
      let result;
      try {
        result = await submitVote({
          issueId: issue.id,
          tokenHash: hash,
          option
        });
      } catch (error) {
        let statusMessage = `${t('submitFailed')}: ${getErrorMessage(error)}`;
        try {
          const currentVoteStatus = await getVoteStatus(issue.id, hash);
          if (currentVoteStatus.voted) {
            hasVoted = true;
            markVotedLocally(issue.id, hash);
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
        alert(statusMessage);
        return;
      }

      const statusText = option === 'approve' ? t('approve') : option === 'oppose' ? t('oppose') : t('neutral');
      const message = `${t('voteRecord')}: ${statusText} ✅`;
      if (result.ok) {
        stats = { issueId: issue.id, counts: result.counts, voted: true };
        const voteGroup = document.querySelector<HTMLElement>(`[data-vote-group="${issue.id}"]`);
        if (voteGroup) updateVoteGroup(voteGroup, result.counts);
        hasVoted = true;
        markVotedLocally(issue.id, hash);
        document.querySelectorAll<HTMLButtonElement>('[data-vote-group] [data-option]').forEach((voteButton) => {
          voteButton.disabled = true;
        });
        const choices = document.querySelector<HTMLElement>(`[data-vote-group="${issue.id}"]`);
        if (choices) choices.setAttribute('title', t('alreadyVoted'));
        voteStatus = { issueId: issue.id, voted: true, option };
      }
      alert(message);
    });
  });

  bindCommentPagination(issue.id);
  bindNavigation();
}

function mountAboutPage() {
  app!.innerHTML = `
    <div class="mx-auto max-w-[var(--page-width)] px-5 pt-6 pb-16">
      ${renderHeader('/about')}
      <main class="grid gap-5">
        <section class="rounded-[22px] border border-border bg-panel p-6 shadow-card">
          <h1 class="mb-3 text-2xl font-bold">${t('aboutTitle')}</h1>
          <p class="text-muted">${t('aboutBody')}</p>
          <ul class="list-disc space-y-2 pl-6">
            <li>${t('aboutPointOne')}</li>
            <li>${t('aboutPointTwo')}</li>
            <li>${t('aboutPointThree')}</li>
          </ul>
        </section>
      </main>
      ${renderFooter()}
    </div>
  `;
  bindNavigation();
}

function mountProposePage() {
  app!.innerHTML = `
    <div class="mx-auto max-w-[var(--page-width)] px-5 pt-6 pb-16">
      ${renderHeader('/submit')}
      <main class="grid gap-5">
        <section class="grid gap-3 rounded-[22px] border border-border bg-panel p-6 shadow-card">
          <h1 class="m-0 text-2xl font-bold">${t('proposalTitle')}</h1>
          <p class="m-0 text-muted">${t('proposalBody')}</p>
          <ol class="list-decimal space-y-1 pl-6">
            <li>${t('proposalRuleOne')}</li>
            <li>${t('proposalRuleTwo')}</li>
            <li>${t('proposalRuleThree')}</li>
            <li>${t('proposalRuleFour')}</li>
            <li>${t('proposalRuleFive')}</li>
          </ol>
          <form class="grid gap-3" data-proposal-form>
            <label class="grid gap-2" for="proposal-title">${t('proposalTitleLabel')}
              <input class="w-full rounded-[14px] border border-border bg-[#f9fbff] px-3.5 py-3" id="proposal-title" name="title" type="text" maxlength="200" required>
            </label>
            <details class="grid gap-2.5">
              <summary class="cursor-pointer text-primary">${t('proposalDescriptionToggle')}</summary>
              <label class="grid gap-2" for="proposal-description">${t('proposalDescriptionLabel')}
                <textarea class="min-h-[140px] w-full resize-y rounded-[14px] border border-border bg-[#f9fbff] px-3.5 py-3" id="proposal-description" name="description" maxlength="2000"></textarea>
              </label>
            </details>
            <label class="grid gap-2" for="proposal-email">${t('proposalEmailLabel')}
              <input class="w-full rounded-[14px] border border-border bg-[#f9fbff] px-3.5 py-3" id="proposal-email" name="email" type="email" autocomplete="email">
            </label>
            <small class="-mt-1.5 text-xs leading-[1.45] text-muted">${t('proposalEmailNote')}</small>
            <fieldset class="m-0 grid gap-2 border-0 p-0">
              <legend class="mb-2 font-semibold">${t('proposalModeLabel')}</legend>
              <div class="grid grid-cols-2 gap-2.5">
                <label class="flex cursor-pointer items-center gap-2.5 rounded-[14px] border border-border bg-[#f9fbff] px-3.5 py-3 has-[:checked]:border-primary has-[:checked]:bg-primary-soft">
                  <input class="accent-primary" type="radio" name="mode" value="evergreen" checked>
                  <span>${t('evergreen')}</span>
                </label>
                <label class="flex cursor-pointer items-center gap-2.5 rounded-[14px] border border-border bg-[#f9fbff] px-3.5 py-3 has-[:checked]:border-primary has-[:checked]:bg-primary-soft">
                  <input class="accent-primary" type="radio" name="mode" value="deadline">
                  <span>${t('deadline')}</span>
                </label>
              </div>
            </fieldset>
            <div class="grid gap-3" data-proposal-schedule hidden>
              <label class="grid gap-2" for="proposal-start">${t('proposalStartLabel')}
                <input class="w-full rounded-[14px] border border-border bg-[#f9fbff] px-3.5 py-3" id="proposal-start" name="startAt" type="datetime-local">
              </label>
              <label class="grid gap-2" for="proposal-end">${t('proposalEndLabel')}
                <input class="w-full rounded-[14px] border border-border bg-[#f9fbff] px-3.5 py-3" id="proposal-end" name="endAt" type="datetime-local">
              </label>
            </div>
            <button class="mx-auto mt-2 cursor-pointer rounded-full border border-primary bg-primary px-4 py-2.5 text-white" type="submit">${t('submitProposal')}</button>
            <p class="m-0 min-h-5 text-muted" data-proposal-status role="status" aria-live="polite"></p>
          </form>
        </section>
      </main>
      ${renderFooter()}
    </div>
  `;

  const proposalForm = document.querySelector('[data-proposal-form]') as HTMLFormElement | null;
  const proposalStatus = document.querySelector('[data-proposal-status]');
  const proposalSchedule = proposalForm?.querySelector('[data-proposal-schedule]') as HTMLDivElement | null;
  const proposalStart = proposalForm?.querySelector('[name="startAt"]') as HTMLInputElement | null;
  const proposalEnd = proposalForm?.querySelector('[name="endAt"]') as HTMLInputElement | null;
  const updateProposalSchedule = (isDeadline: boolean) => {
    if (proposalSchedule) proposalSchedule.hidden = !isDeadline;
    if (proposalStart) proposalStart.required = isDeadline;
    if (proposalEnd) proposalEnd.required = isDeadline;
  };
  proposalForm?.addEventListener('change', (event) => {
    if (!(event.target instanceof HTMLInputElement) || event.target.name !== 'mode') return;
    updateProposalSchedule(event.target.value === 'deadline');
  });
  proposalStart?.addEventListener('change', () => {
    if (proposalEnd) proposalEnd.min = proposalStart.value;
  });
  proposalForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(proposalForm);
    const title = String(formData.get('title') ?? '').trim();
    const description = String(formData.get('description') ?? '').trim();
    const modeValue = formData.get('mode');
    const mode = modeValue === 'deadline' ? 'deadline' : 'evergreen';
    const startAt = String(formData.get('startAt') ?? '');
    const endAt = String(formData.get('endAt') ?? '');
    const email = String(formData.get('email') ?? '').trim();
    const submitButton = proposalForm.querySelector('button[type="submit"]') as HTMLButtonElement;
    submitButton.disabled = true;
    if (proposalStatus) proposalStatus.textContent = '';

    try {
      const result = await submitProposal({
        title,
        description: description || undefined,
        mode,
        startAt: mode === 'deadline' ? new Date(startAt).toISOString() : undefined,
        endAt: mode === 'deadline' ? new Date(endAt).toISOString() : undefined,
        email: email || undefined
      });
      if (proposalStatus) {
        const submitter = result.submitter ?? t('anonymousSubmitter');
        proposalStatus.textContent = `${t('proposalSubmitted')}: ${result.proposalId} · ${submitter}`;
      }
      proposalForm.reset();
      updateProposalSchedule(false);
    } catch (error) {
      if (proposalStatus) proposalStatus.textContent = `${t('proposalSubmitFailed')} ${getErrorMessage(error)}`;
    } finally {
      submitButton.disabled = false;
    }
  });

  bindNavigation();
}

function mountClaimProposalPage() {
  app!.innerHTML = `
    <div class="mx-auto max-w-[var(--page-width)] px-5 pt-6 pb-16">
      ${renderHeader('/submit')}
      <main class="grid gap-5">
        <section class="grid gap-3 rounded-[22px] border border-border bg-panel p-6 shadow-card">
          <h1 class="m-0 text-2xl font-bold">${t('claimProposalTitle')}</h1>
          <p class="m-0 text-muted">${t('claimProposalDescription')}</p>
          <form class="grid gap-3" data-claim-form>
            <label class="grid gap-2" for="claim-proposal-id">${t('claimProposalIdLabel')}
              <input class="w-full rounded-[14px] border border-border bg-[#f9fbff] px-3.5 py-3" id="claim-proposal-id" name="proposalId" type="text" inputmode="numeric" placeholder="47" required>
            </label>
            <label class="grid gap-2" for="claim-email">${t('claimEmailLabel')}
              <input class="w-full rounded-[14px] border border-border bg-[#f9fbff] px-3.5 py-3" id="claim-email" name="email" type="email" autocomplete="email" required>
            </label>
            <button class="mx-auto mt-2 cursor-pointer rounded-full border border-primary bg-primary px-4 py-2.5 text-white" type="submit">${t('claimProposal')}</button>
            <p class="m-0 min-h-5 text-muted" data-claim-status role="status" aria-live="polite"></p>
          </form>
        </section>
      </main>
      ${renderFooter()}
    </div>
  `;

  const claimForm = document.querySelector('[data-claim-form]') as HTMLFormElement | null;
  const claimStatus = document.querySelector('[data-claim-status]');
  claimForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(claimForm);
    const proposalId = String(formData.get('proposalId') ?? '').trim();
    const email = String(formData.get('email') ?? '').trim();
    const submitButton = claimForm.querySelector('button[type="submit"]') as HTMLButtonElement;
    submitButton.disabled = true;
    if (claimStatus) claimStatus.textContent = '';

    try {
      const result = await claimProposal(proposalId, email);
      if (claimStatus) claimStatus.textContent = `${t('claimConfirmed')}: ${result.proposalId} · ${result.submitter}`;
    } catch (error) {
      if (claimStatus) claimStatus.textContent = `${t('claimFailed')} ${getErrorMessage(error)}`;
    } finally {
      submitButton.disabled = false;
    }
  });

  bindNavigation();
}

function bindNavigation() {
  document.querySelectorAll('[data-route]').forEach((element) => {
    element.addEventListener('click', (event) => {
      event.preventDefault();
      const route = element.getAttribute('data-route') || '/';
      window.history.pushState({}, '', route);
      render();
    });
  });
}

async function render() {
  document.documentElement.lang = DEFAULT_LOCALE;
  document.title = getSiteName();
  const route = getCurrentRoute();

  if (route === '/about') {
    mountAboutPage();
    return;
  }

  if (route === '/propose' || route === '/propose/claim') {
    const canonicalRoute = route.replace(/^\/propose/, '/submit');
    window.history.replaceState({}, '', canonicalRoute);
    await render();
    return;
  }

  if (route === '/submit') {
    mountProposePage();
    return;
  }

  if (route === '/submit/claim') {
    mountClaimProposalPage();
    return;
  }

  if (route === '/polls') {
    await mountHome();
    return;
  }

  if (route.startsWith('/vote/')) {
    const legacyRoute = route.replace(/^\/vote\//, '/poll/');
    window.history.replaceState({}, '', legacyRoute);
    await render();
    return;
  }

  if (route.startsWith('/poll/')) {
    const issueId = Number(route.split('/').pop() ?? '11');
    await mountVotePage(Number.isFinite(issueId) ? issueId : 11);
    return;
  }

  await mountHome();
}

window.addEventListener('popstate', () => { render(); });
render();
