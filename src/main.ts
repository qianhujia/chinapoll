import './styles.css';
import { getLocaleText, DEFAULT_LOCALE } from './i18n';
import { claimProposal, createToken, getComments, getStats, getVoteStatus, hasVotedLocally, hashToken, markVotedLocally, submitComment, submitProposal, submitVote, type CommentsResponse, type VoteOption } from './lib/poll';

const app = document.querySelector('#app');
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

function renderFooter(): string {
  const dataUrl = import.meta.env.VITE_DATA_GITHUB_URL;

  return `
    <footer class="footer">
      <span>Powered by <a class="footer-brand" href="https://github.com/qianhujia/chinapoll" target="_blank" rel="noopener noreferrer">${getSiteName()}</a></span>
      <a class="footer-link" href="/propose/claim" data-route="/propose/claim">${t('claimProposalLink')}</a>
      ${dataUrl ? `<a class="footer-link" href="${dataUrl}" target="_blank" rel="noopener noreferrer">${t('dataLink')}</a>` : ''}
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
    <nav class="pagination" aria-label="${t('pagination')}">
      <button class="nav-button" ${attribute}="${page - 1}" ${page === 1 ? 'disabled' : ''}>${t('previousPage')}</button>
      <span>${t('pageOf')} ${page} / ${totalPages}</span>
      <button class="nav-button" ${attribute}="${page + 1}" ${page === totalPages ? 'disabled' : ''}>${t('nextPage')}</button>
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
    ? `<ul class="comment-list">${response.comments.map(({ id, comment, createdAt }) => `
        <li class="public-comment">
          <p>${escapeHtml(comment)}</p>
          <time datetime="${escapeHtml(createdAt)}">${escapeHtml(createdAt)}</time>
        </li>
      `).join('')}</ul>`
    : `<p class="muted">${t('noComments')}</p>`;

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
      return `/vote/${id}`;
    }
  }

  return path === '' ? '/' : path;
}

function getNavigationMarkup(activeRoute: string): string {
  const links = [
    { route: '/', label: t('home') },
    { route: '/about', label: t('about') },
    { route: '/propose', label: t('propose') }
  ];

  return links.map(({ route, label }) => `
    <a class="nav-link ${activeRoute === route ? 'active' : ''}" href="${route}" data-route="${route}">${label}</a>
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
      <div class="page-shell">
        <header class="topbar">
          <div class="brand-wrap">
            <a class="brand-link" href="/" data-route="/" aria-label="${t('homeLinkLabel')}">${getSiteName()}</a>
            <div class="tagline">${getSiteSlogan()}</div>
          </div>
          <nav class="nav">${getNavigationMarkup('/')}</nav>
        </header>
        <main class="container"><p class="vote-status">${t('statsLoadFailed')} ${getErrorMessage(error)}</p></main>
        ${renderFooter()}
      </div>
    `;
    bindNavigation();
    return;
  }

  const totalVotes = issueStats.reduce((sum, { stats }) => {
    return sum + stats.counts.approve + stats.counts.oppose + stats.counts.neutral;
  }, 0);
  const totalPages = Math.ceil(issueStats.length / POLLS_PER_PAGE);
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const visibleIssueStats = issueStats.slice((currentPage - 1) * POLLS_PER_PAGE, currentPage * POLLS_PER_PAGE);

  app!.innerHTML = `
    <div class="page-shell">
      <header class="topbar">
        <div class="brand-wrap">
          <a class="brand-link" href="/" data-route="/" aria-label="${t('homeLinkLabel')}">${getSiteName()}</a>
          <div class="tagline">${getSiteSlogan()}</div>
        </div>
        <nav class="nav">
          ${getNavigationMarkup('/')}
        </nav>
      </header>

      <main class="container">
        <section class="hero">
          <h1>${t('heroTitle')}</h1>
          <p>${t('heroBody')}</p>
        </section>

        <section class="card stats-grid">
          <div>
            <span class="label">${t('openPolls')}</span>
            <strong>${sampleIssues.length}</strong>
          </div>
          <div>
            <span class="label">${t('totalVotes')}</span>
            <strong>${totalVotes}</strong>
          </div>
          <div>
            <span class="label">${t('modes')}</span>
            <strong>${t('deadline')} + ${t('evergreen')}</strong>
          </div>
        </section>

        <section class="poll-list">
          ${visibleIssueStats.map(({ issue, stats }) => {
            const total = stats.counts.approve + stats.counts.oppose + stats.counts.neutral;
            return `
              <article class="poll-row">
                <div class="poll-header">
                  <div>
                    <span class="eyebrow">${t('issuePrefix')} #${issue.id}</span>
                    <h2><a class="poll-title-link" href="/vote/${issue.id}" data-route="/vote/${issue.id}">${issue.title}</a></h2>
                  </div>
                </div>

                <div class="poll-meta">
                  <span>${issue.mode === 'deadline' ? t('deadline') : t('evergreen')}</span>
                  <span>${total} ${t('votes')}</span>
                </div>

                <div class="bar-group">
                  <div class="bar-row">
                    <span>${t('approve')}</span>
                    <div class="bar"><i style="width:${(stats.counts.approve / Math.max(1, total)) * 100}%"></i></div>
                    <strong>${stats.counts.approve}</strong>
                  </div>
                  <div class="bar-row">
                    <span>${t('neutral')}</span>
                    <div class="bar"><i style="width:${(stats.counts.neutral / Math.max(1, total)) * 100}%"></i></div>
                    <strong>${stats.counts.neutral}</strong>
                  </div>
                  <div class="bar-row">
                    <span>${t('oppose')}</span>
                    <div class="bar"><i style="width:${(stats.counts.oppose / Math.max(1, total)) * 100}%"></i></div>
                    <strong>${stats.counts.oppose}</strong>
                  </div>
                </div>
              </article>
            `;
          }).join('')}
        </section>
        ${renderPagination(currentPage, totalPages, 'data-poll-page')}
      </main>

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

  app!.innerHTML = `
    <div class="page-shell narrow">
      <header class="topbar">
        <div class="brand-wrap">
          <a class="brand-link" href="/" data-route="/" aria-label="${t('homeLinkLabel')}">${getSiteName()}</a>
        </div>
        <nav class="nav">
          ${getNavigationMarkup('/polls')}
        </nav>
      </header>

      <main class="container vote-page">
        <section class="card issue-intro">
          <span class="eyebrow">${t('issuePrefix')} #${issue.id}</span>
          <h1>${issue.title}</h1>
          <p class="muted">${issue.title}</p>

          ${stats ? `<div class="choice-stack">
            <button class="choice approve" data-option="approve" ${hasVoted || voteStatusError ? 'disabled' : ''}>
              <span class="choice-label">
                <svg class="vote-icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24"><path d="M12 4q.8 0 1.2.7l7.8 13.6q.8 1.4-.9 1.4H3.9q-1.7 0-.9-1.4l7.8-13.6q.4-.7 1.2-.7Z"/></svg>
                ${t('approve')}
              </span>
              <span class="choice-count">${stats.counts.approve}</span>
            </button>
            <button class="choice neutral" data-option="neutral" ${hasVoted || voteStatusError ? 'disabled' : ''}>
              <span class="choice-label">
                <svg class="vote-icon neutral-icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>
                ${t('neutral')}
              </span>
              <span class="choice-count">${stats.counts.neutral}</span>
            </button>
            <button class="choice oppose" data-option="oppose" ${hasVoted || voteStatusError ? 'disabled' : ''}>
              <span class="choice-label">
                <svg class="vote-icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24"><path d="M3.9 3h16.2q1.7 0 .9 1.4l-7.8 13.6q-1.2 1.8-2.4 0L3 4.4Q2.2 3 3.9 3Z"/></svg>
                ${t('oppose')}
              </span>
              <span class="choice-count">${stats.counts.oppose}</span>
            </button>
          </div>` : ''}

          <p class="vote-status" role="status">${voteStatusError
    ? `${t('voteStatusFailed')} ${voteStatusError}`
    : statsError
      ? `${t('statsLoadFailed')} ${statsError}`
    : hasVoted ? t('alreadyVoted') : ''}</p>
        </section>

        <section class="card privacy-note">
          <small>${t('privacyText')}</small>
        </section>

        <section class="card comment-box">
          <label for="comment">${t('anonymousComment')}</label>
          <textarea id="comment" maxlength="140" rows="4" placeholder="${t('commentPlaceholder')}"></textarea>
          <button class="primary" type="button" data-submit-comment>${t('submitComment')}</button>
          <p class="comment-submit-status" role="status" aria-live="polite"></p>
        </section>

        <section class="card comments-section">
          <h2>${t('commentsTitle')}</h2>
          <div id="comments-content">${commentsContent}</div>
        </section>

        <div class="token-meta">token_hash: ${hash.slice(0, 12)}</div>
      </main>
      ${renderFooter()}
    </div>
  `;

  const commentButton = document.querySelector('[data-submit-comment]') as HTMLButtonElement | null;
  const commentInput = document.querySelector('#comment') as HTMLTextAreaElement | null;
  const commentStatus = document.querySelector('.comment-submit-status');
  commentButton?.addEventListener('click', async () => {
    const comment = commentInput?.value.trim() ?? '';
    if (!comment) {
      if (commentStatus) commentStatus.textContent = t('emptyComment');
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
        for (const option of ['approve', 'neutral', 'oppose'] as const) {
          const count = document.querySelector(`[data-option="${option}"] .choice-count`);
          if (count) count.textContent = String(result.counts[option]);
        }
        hasVoted = true;
        markVotedLocally(issue.id, hash);
        document.querySelectorAll<HTMLButtonElement>('[data-option]').forEach((voteButton) => {
          voteButton.disabled = true;
        });
        voteStatus = { issueId: issue.id, voted: true, option };
        const statusMessage = document.querySelector('.vote-status');
        if (statusMessage) statusMessage.textContent = t('alreadyVoted');
      }
      alert(message);
    });
  });

  bindCommentPagination(issue.id);
  bindNavigation();
}

function mountAboutPage() {
  app!.innerHTML = `
    <div class="page-shell narrow">
      <header class="topbar">
        <div class="brand-wrap">
          <a class="brand-link" href="/" data-route="/" aria-label="${t('homeLinkLabel')}">${getSiteName()}</a>
        </div>
        <nav class="nav">
          ${getNavigationMarkup('/about')}
        </nav>
      </header>
      <main class="container">
        <section class="card">
          <h1>${t('aboutTitle')}</h1>
          <p>${t('aboutBody')}</p>
          <ul>
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
    <div class="page-shell narrow">
      <header class="topbar">
        <div class="brand-wrap">
          <a class="brand-link" href="/" data-route="/" aria-label="${t('homeLinkLabel')}">${getSiteName()}</a>
        </div>
        <nav class="nav">
          ${getNavigationMarkup('/propose')}
        </nav>
      </header>
      <main class="container">
        <section class="card proposal-form">
          <h1>${t('proposalTitle')}</h1>
          <p>${t('proposalBody')}</p>
          <ol>
            <li>${t('proposalRuleOne')}</li>
            <li>${t('proposalRuleTwo')}</li>
            <li>${t('proposalRuleThree')}</li>
            <li>${t('proposalRuleFour')}</li>
            <li>${t('proposalRuleFive')}</li>
          </ol>
          <form data-proposal-form>
            <label for="proposal-title">${t('proposalTitleLabel')}
              <input id="proposal-title" name="title" type="text" maxlength="200" required>
            </label>
            <details class="proposal-description">
              <summary>${t('proposalDescriptionToggle')}</summary>
              <label for="proposal-description">${t('proposalDescriptionLabel')}
                <textarea id="proposal-description" name="description" maxlength="2000"></textarea>
              </label>
            </details>
            <label for="proposal-email">${t('proposalEmailLabel')}
              <input id="proposal-email" name="email" type="email" autocomplete="email">
            </label>
            <small>${t('proposalEmailNote')}</small>
            <fieldset class="proposal-mode">
              <legend>${t('proposalModeLabel')}</legend>
              <div class="proposal-mode-options">
                <label class="proposal-mode-option">
                  <input type="radio" name="mode" value="evergreen" checked>
                  <span>${t('evergreen')}</span>
                </label>
                <label class="proposal-mode-option">
                  <input type="radio" name="mode" value="deadline">
                  <span>${t('deadline')}</span>
                </label>
              </div>
            </fieldset>
            <div class="proposal-schedule" data-proposal-schedule hidden>
              <label for="proposal-start">${t('proposalStartLabel')}
                <input id="proposal-start" name="startAt" type="datetime-local">
              </label>
              <label for="proposal-end">${t('proposalEndLabel')}
                <input id="proposal-end" name="endAt" type="datetime-local">
              </label>
            </div>
            <button class="primary" type="submit">${t('submitProposal')}</button>
            <p class="proposal-status" data-proposal-status role="status" aria-live="polite"></p>
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
    <div class="page-shell narrow">
      <header class="topbar">
        <div class="brand-wrap">
          <a class="brand-link" href="/" data-route="/" aria-label="${t('homeLinkLabel')}">${getSiteName()}</a>
        </div>
        <nav class="nav">
          ${getNavigationMarkup('/propose')}
        </nav>
      </header>
      <main class="container">
        <section class="card proposal-form">
          <h1>${t('claimProposalTitle')}</h1>
          <p>${t('claimProposalDescription')}</p>
          <form data-claim-form>
            <label for="claim-proposal-id">${t('claimProposalIdLabel')}
              <input id="claim-proposal-id" name="proposalId" type="text" inputmode="numeric" placeholder="47" required>
            </label>
            <label for="claim-email">${t('claimEmailLabel')}
              <input id="claim-email" name="email" type="email" autocomplete="email" required>
            </label>
            <button class="primary" type="submit">${t('claimProposal')}</button>
            <p class="proposal-status" data-claim-status role="status" aria-live="polite"></p>
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

  if (route === '/propose') {
    mountProposePage();
    return;
  }

  if (route === '/propose/claim') {
    mountClaimProposalPage();
    return;
  }

  if (route === '/polls') {
    await mountHome();
    return;
  }

  if (route.startsWith('/vote/')) {
    const issueId = Number(route.split('/').pop() ?? '11');
    await mountVotePage(Number.isFinite(issueId) ? issueId : 11);
    return;
  }

  await mountHome();
}

window.addEventListener('popstate', () => { render(); });
render();
