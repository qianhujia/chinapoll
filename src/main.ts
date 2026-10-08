import './styles.css';
import { getLocaleText, DEFAULT_LOCALE } from './i18n';
import { createToken, getStats, hashToken, submitVote, type VoteOption } from './lib/poll';

const app = document.querySelector('#app');

type PollIssue = {
  id: number;
  title: string;
  mode: 'deadline' | 'evergreen';
  start_at: string;
  end_at?: string | null;
  status: 'open' | 'closed' | 'archived';
};

const pollTitles = [
  'Should schools add mandatory digital literacy coursework?',
  'Should the public adopt a unified yearly public-opinion snapshot mechanism?',
  'Should public budget transparency be published monthly?',
  'Should major community matters require public hearings?',
  'Should cities charge congestion fees by time-of-day on roads?',
  'Should libraries extend evening operating hours?',
  'Should government data API changelogs be publicly published?',
  'Should urban greenways be managed under one maintenance plan?',
  'Should communities adopt stricter shared-bike parking rules?',
  'Should public transit route data be released in real time?',
  'Should graduate employment data be publicly published annually?',
  'Should digital health records be queryable by patients?',
  'Should community consultation platforms publish their results openly?',
  'Should government websites include citizen-budget visualizations?',
  'Should public facility maintenance plans be disclosed quarterly?',
  'Should local education resources be subject to standard evaluations?',
  'Should community parking revenue be disclosed transparently?',
  'Should public places add stronger accessibility feedback channels?',
  'Should blockchain be used to trace food supply chains?',
  'Should local governments publish bid success rate data?',
  'Should environmental data follow a unified regional reporting standard?',
  'Should schools implement stricter cybersecurity education programs?',
  'Should public service satisfaction reports be published quarterly?',
  'Should community public spaces include open voting kiosks?',
  'Should detailed infrastructure capital spending be published publicly?',
  'Should public event risk assessments be published publicly?',
  'Should public-policy research results be audited by third-party groups?',
  'Should local debt risk briefings be made public?',
  'Should hospitals publish prices in a more transparent display?',
  'Should senior community services be evaluated through a public mechanism?',
  'Should digital billboard deployment follow stricter transparency rules?'
];

function t(key: string): string {
  return getLocaleText(DEFAULT_LOCALE, key);
}

function buildSampleIssues(): PollIssue[] {
  return Array.from({ length: 30 }, (_, index) => {
    const id = index + 11;
    const title = pollTitles[index] ?? 'Should public governance become more transparent?';
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

function buildCountsForIssue(issueId: number): Record<VoteOption, number> {
  const base = 40 + (issueId * 11) % 180;
  const approve = base;
  const oppose = Math.max(14, Math.round(base * 0.52));
  const neutral = Math.max(10, Math.round(base * 0.27));
  return { approve, oppose, neutral };
}

function getIssueById(issueId: number): PollIssue {
  return sampleIssues.find((issue) => issue.id === issueId) ?? sampleIssues[0];
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
    { route: '/polls', label: t('allPolls') },
    { route: '/about', label: t('about') },
    { route: '/propose', label: t('propose') }
  ];

  return links.map(({ route, label }) => `
    <button class="${activeRoute === route ? 'nav-button active' : 'nav-button'}" data-route="${route}">${label}</button>
  `).join('');
}

async function mountHome() {
  const issueStats = await Promise.all(sampleIssues.map(async (issue) => {
    const stats = await getStats(issue.id).catch(() => ({
      issueId: issue.id,
      counts: buildCountsForIssue(issue.id),
      voted: false
    }));
    return { issue, stats };
  }));

  const totalVotes = issueStats.reduce((sum, { stats }) => {
    return sum + stats.counts.approve + stats.counts.oppose + stats.counts.neutral;
  }, 0);

  app!.innerHTML = `
    <div class="page-shell">
      <header class="topbar">
        <div class="brand-wrap">
          <a class="brand-link" href="/" data-route="/" aria-label="${t('homeLinkLabel')}">${t('appName')}</a>
          <div class="tagline">${t('tagline')}</div>
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
          ${issueStats.map(({ issue, stats }) => {
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
                    <span>${t('oppose')}</span>
                    <div class="bar"><i style="width:${(stats.counts.oppose / Math.max(1, total)) * 100}%"></i></div>
                    <strong>${stats.counts.oppose}</strong>
                  </div>
                  <div class="bar-row">
                    <span>${t('neutral')}</span>
                    <div class="bar"><i style="width:${(stats.counts.neutral / Math.max(1, total)) * 100}%"></i></div>
                    <strong>${stats.counts.neutral}</strong>
                  </div>
                </div>
              </article>
            `;
          }).join('')}
        </section>
      </main>

      <footer class="footer">
        ${t('openSource')} · ${t('noLogin')} · ${t('oneToken')} · ${t('publicResults')}
      </footer>
    </div>
  `;

  bindNavigation();
}

async function mountVotePage(issueId: number) {
  const issue = getIssueById(issueId);
  const token = createToken();
  const hash = await hashToken(token);
  const counts = buildCountsForIssue(issue.id);

  app!.innerHTML = `
    <div class="page-shell narrow">
      <header class="topbar">
        <div class="brand-wrap">
          <a class="brand-link" href="/" data-route="/" aria-label="${t('homeLinkLabel')}">${t('appName')}</a>
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
        </section>

        <section class="card choice-stack">
          <button class="choice approve" data-option="approve">${t('approve')} <span>${counts.approve}</span></button>
          <button class="choice oppose" data-option="oppose">${t('oppose')} <span>${counts.oppose}</span></button>
          <button class="choice neutral" data-option="neutral">${t('neutral')} <span>${counts.neutral}</span></button>
        </section>

        <section class="card privacy-note">
          <small>${t('privacyText')}</small>
        </section>

        <section class="card comment-box">
          <label for="comment">${t('anonymousComment')}</label>
          <textarea id="comment" maxlength="140" rows="4" placeholder="${t('commentPlaceholder')}"></textarea>
        </section>

        <div class="token-meta">token_hash: ${hash.slice(0, 12)}</div>
      </main>
    </div>
  `;

  document.querySelectorAll('[data-option]').forEach((button) => {
    button.addEventListener('click', async () => {
      const option = button.getAttribute('data-option') as 'approve' | 'oppose' | 'neutral';
      const tokenHash = await hashToken(token);
      const result = await submitVote({
        issueId: issue.id,
        tokenHash,
        option,
        comment: (document.querySelector('#comment') as HTMLTextAreaElement | null)?.value || ''
      }).catch((error) => ({
        ok: false,
        message: String(error.message ?? error),
        counts: buildCountsForIssue(issue.id),
        voted: false
      }));

      const statusText = option === 'approve' ? t('approve') : option === 'oppose' ? t('oppose') : t('neutral');
      const message = result.ok ? `${t('voteRecord')}: ${statusText} ✅` : `${t('submitFailed')}: ${result.message}`;
      alert(message);
    });
  });

  bindNavigation();
}

function mountAboutPage() {
  app!.innerHTML = `
    <div class="page-shell narrow">
      <header class="topbar">
        <div class="brand-wrap">
          <a class="brand-link" href="/" data-route="/" aria-label="${t('homeLinkLabel')}">${t('appName')}</a>
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
    </div>
  `;
  bindNavigation();
}

function mountProposePage() {
  app!.innerHTML = `
    <div class="page-shell narrow">
      <header class="topbar">
        <div class="brand-wrap">
          <a class="brand-link" href="/" data-route="/" aria-label="${t('homeLinkLabel')}">${t('appName')}</a>
        </div>
        <nav class="nav">
          ${getNavigationMarkup('/propose')}
        </nav>
      </header>
      <main class="container">
        <section class="card">
          <h1>${t('proposalTitle')}</h1>
          <p>${t('proposalBody')}</p>
          <ol>
            <li>${t('proposalRuleOne')}</li>
            <li>${t('proposalRuleTwo')}</li>
            <li>${t('proposalRuleThree')}</li>
            <li>${t('proposalRuleFour')}</li>
            <li>${t('proposalRuleFive')}</li>
          </ol>
        </section>
      </main>
    </div>
  `;
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
  const route = getCurrentRoute();

  if (route === '/about') {
    mountAboutPage();
    return;
  }

  if (route === '/propose') {
    mountProposePage();
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
