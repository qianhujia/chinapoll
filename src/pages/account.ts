// The signed-in dashboard: a left-hand menu with the account sections and the panel
// of the selected one.
//
// The three sections live under their own routes (`/account`, `/account/polls`,
// `/account/comments`) so a section can be linked to and reloaded directly, and the
// markup builders are pure strings so they can be tested without a DOM.

import {
  closeUserPoll,
  deleteAccount,
  deleteUserComment,
  deleteUserPoll,
  getCurrentUser,
  getRecoveryCodeStatus,
  getUserComments,
  getUserPolls,
  logoutAllDevices,
  logoutUser,
  regenerateRecoveryCode,
  type UserComment,
  type UserPoll
} from '../lib/session';
import { escapeHtml, getErrorMessage, renderFooter, renderHeader, renderRecoveryCode, renderToast, showToast, t } from '../ui';

// The sections of the dashboard, in menu order.
export type AccountSection = 'account' | 'polls' | 'comments';

export const ACCOUNT_SECTIONS: ReadonlyArray<{ section: AccountSection; route: string; labelKey: string }> = [
  { section: 'account', route: '/account', labelKey: 'account' },
  { section: 'polls', route: '/account/polls', labelKey: 'accountPollsTitle' },
  { section: 'comments', route: '/account/comments', labelKey: 'accountCommentsTitle' }
];

export function accountSectionFromRoute(route: string): AccountSection {
  if (route === '/account/polls') return 'polls';
  if (route === '/account/comments') return 'comments';
  return 'account';
}

// The left-hand menu. The active section is marked with `aria-current` and the same
// bold/primary styling the header navigation uses.
export function accountMenuMarkup(active: AccountSection): string {
  const items = ACCOUNT_SECTIONS.map(({ section, route, labelKey }) => {
    const isActive = section === active;
    const style = isActive
      ? 'bg-[#eef3fb] font-bold text-primary'
      : 'text-muted hover:bg-[#f9fbff] hover:text-primary';
    return `
      <li>
        <a
          class="block rounded-[14px] px-3.5 py-2.5 no-underline ${style}"
          href="${route}"
          data-route="${route}"
          data-account-nav="${section}"
          ${isActive ? 'aria-current="page"' : ''}
        >${t(labelKey)}</a>
      </li>
    `;
  }).join('');

  return `
    <nav class="grid gap-1 rounded-[22px] border border-border bg-panel p-3 shadow-card" aria-label="${t('accountMenuLabel')}">
      <ul class="m-0 grid list-none gap-1 p-0">${items}</ul>
    </nav>
  `;
}

function statusLabel(status: UserPoll['status']): string {
  if (status === 'open') return t('statusOpen');
  if (status === 'closed') return t('statusClosed');
  if (status === 'archived') return t('statusArchived');
  return t('statusPending');
}

function pollCardMarkup(poll: UserPoll): string {
  const canClose = poll.status === 'open';
  const canWithdraw = poll.status === 'pending';
  const actions = [
    canClose
      ? `<button class="cursor-pointer rounded-full border border-border bg-panel px-3 py-1.5 text-sm text-ink hover:border-primary hover:text-primary" type="button" data-close-poll="${poll.id}">${t('accountClose')}</button>`
      : '',
    canWithdraw
      ? `<button class="cursor-pointer rounded-full border border-border bg-panel px-3 py-1.5 text-sm text-ink hover:border-[#d95b5b] hover:text-[#d95b5b]" type="button" data-delete-poll="${poll.id}">${t('accountWithdraw')}</button>`
      : ''
  ].join(' ');

  return `
    <li class="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3.5">
      <div class="grid gap-1">
        <a class="font-semibold text-primary" href="/poll/${poll.number ?? poll.id}" data-route="/poll/${poll.number ?? poll.id}">#${poll.number ?? poll.id} ${escapeHtml(poll.title ?? '')}</a>
        <span class="text-xs text-muted">${statusLabel(poll.status)} \u00b7 ${escapeHtml(poll.createdAt)}</span>
      </div>
      <div class="flex items-center gap-2">${actions}</div>
    </li>
  `;
}

function commentCardMarkup(comment: UserComment): string {
  return `
    <li class="flex flex-wrap items-start justify-between gap-3 border-b border-border py-3.5">
      <div class="grid min-w-0 gap-1">
        <p class="m-0 whitespace-pre-wrap break-words">${escapeHtml(comment.comment)}</p>
        <span class="text-xs text-muted">
          <a class="text-primary" href="/poll/${comment.pollNumber ?? comment.pollId}" data-route="/poll/${comment.pollNumber ?? comment.pollId}">#${comment.pollNumber ?? comment.pollId} ${escapeHtml(comment.pollTitle ?? '')}</a>
          \u00b7 ${escapeHtml(comment.createdAt)}
        </span>
      </div>
      <button class="shrink-0 cursor-pointer rounded-full border border-border bg-panel px-3 py-1.5 text-sm text-ink hover:border-[#d95b5b] hover:text-[#d95b5b]" type="button" data-delete-comment="${escapeHtml(comment.id)}">${t('accountDeleteComment')}</button>
    </li>
  `;
}

// A "Load more" button, shown under a list only while a further page exists.
function loadMoreMarkup(target: 'polls' | 'comments'): string {
  return `<button class="mt-4 cursor-pointer rounded-full border border-border bg-panel px-3.5 py-2 text-sm text-ink hover:border-primary hover:text-primary" type="button" data-load-more-${target}>${t('accountLoadMore')}</button>`;
}


// The "My account" panel: who is signed in, the recovery code, signing other devices
// out, and deleting the account.
export function accountPanelMarkup(user: { username: string; createdAt: string }, hasRecoveryCode: boolean): string {
  return `
    <section class="grid gap-3 rounded-[22px] border border-border bg-panel p-6 shadow-card">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h1 class="m-0 text-2xl font-bold">${t('accountTitle')}</h1>
        <button class="cursor-pointer rounded-full border border-border bg-panel px-3 py-1.5 text-sm text-ink hover:border-primary hover:text-primary" type="button" data-logout>${t('logout')}</button>
      </div>
      <p class="m-0 text-muted">${t('accountSignedInAs')} <strong>${escapeHtml(user.username)}</strong></p>
      <p class="m-0 text-xs text-muted">${t('accountCreatedAt')}: ${escapeHtml(user.createdAt)}</p>
      <p class="m-0 rounded-[14px] border border-[#f0c36d] bg-[#fff7e6] px-3.5 py-3 text-sm text-ink" role="note">${t('registerWarning')}</p>
    </section>

    <section class="grid gap-3 rounded-[22px] border border-border bg-panel p-6 shadow-card">
      <h2 class="m-0 text-xl font-bold">${t('recoveryCodeTitle')}</h2>
      <p class="m-0 text-muted">${t('recoveryCodeAccountBody')}</p>
      <p class="m-0 text-sm text-muted">${hasRecoveryCode ? t('recoveryCodeConfigured') : t('recoveryCodeNotConfigured')}</p>
      <p class="m-0 rounded-[14px] border border-[#f0c36d] bg-[#fff7e6] px-3.5 py-3 text-sm text-ink" role="note">${t('recoveryCodeWarning')}</p>
      <p class="m-0 rounded-[14px] border border-[#f0c36d] bg-[#fff7e6] px-3.5 py-3 text-sm text-ink" role="note">${t('recoveryCodeRegenerateNote')}</p>
      <div>
        <button class="cursor-pointer rounded-full border border-border bg-panel px-3.5 py-2 text-sm text-ink hover:border-primary hover:text-primary" type="button" data-regenerate-recovery>${t('recoveryCodeRegenerate')}</button>
      </div>
      <div data-recovery-output></div>
      <div class="grid gap-2 border-t border-border pt-3">
        <p class="m-0 text-sm text-muted">${t('accountLogoutAllNote')}</p>
        <div>
          <button class="cursor-pointer rounded-full border border-border bg-panel px-3.5 py-2 text-sm text-ink hover:border-primary hover:text-primary" type="button" data-logout-all>${t('accountLogoutAll')}</button>
        </div>
      </div>
    </section>

    <section class="grid gap-3 rounded-[22px] border border-[#e2a9a9] bg-panel p-6 shadow-card">
      <h2 class="m-0 text-xl font-bold">${t('accountDeleteTitle')}</h2>
      <p class="m-0 text-muted">${t('accountDeleteBody')}</p>
      <div>
        <button class="cursor-pointer rounded-full border border-[#d95b5b] bg-panel px-3.5 py-2 text-sm text-[#d95b5b] hover:bg-[#faeaea]" type="button" data-delete-account>${t('accountDeleteAction')}</button>
      </div>
    </section>
  `;
}

// The "My polls" panel: the polls this account submitted, newest first, one page at
// a time.
export function accountPollsPanelMarkup(polls: UserPoll[], hasMore: boolean, loadError: string): string {
  const body = loadError
    ? `<p class="m-0 text-muted">${escapeHtml(t('accountLoadFailed'))} ${escapeHtml(loadError)}</p>`
    : polls.length
      ? `<ul class="m-0 grid list-none gap-0 p-0">${polls.map(pollCardMarkup).join('')}</ul>`
      : `<p class="m-0 text-muted">${t('accountNoPolls')}</p>`;

  return `
    <section class="rounded-[22px] border border-border bg-panel p-6 shadow-card">
      <h1 class="mb-3.5 text-2xl font-bold">${t('accountPollsTitle')}</h1>
      ${body}
      ${loadError ? '' : (hasMore ? loadMoreMarkup('polls') : '')}
    </section>
  `;
}

// The "My comments" panel: the comments this account posted, newest first, one page
// at a time.
export function accountCommentsPanelMarkup(comments: UserComment[], hasMore: boolean, loadError: string): string {
  const body = loadError
    ? `<p class="m-0 text-muted">${escapeHtml(t('accountLoadFailed'))} ${escapeHtml(loadError)}</p>`
    : comments.length
      ? `<ul class="m-0 grid list-none gap-0 p-0">${comments.map(commentCardMarkup).join('')}</ul>`
      : `<p class="m-0 text-muted">${t('accountNoComments')}</p>`;

  return `
    <section class="rounded-[22px] border border-border bg-panel p-6 shadow-card">
      <h1 class="mb-3.5 text-2xl font-bold">${t('accountCommentsTitle')}</h1>
      ${body}
      ${loadError ? '' : (hasMore ? loadMoreMarkup('comments') : '')}
    </section>
  `;
}

// The two-column shell: the menu on the left, the selected panel on the right. The
// columns stack on a narrow screen so the menu stays usable on a phone.
export function accountDashboardMarkup(active: AccountSection, panel: string): string {
  return `
    <div class="mx-auto max-w-[var(--page-width)] px-5 pt-6 pb-16">
      ${renderHeader('/account')}
      <main class="grid items-start gap-5 md:grid-cols-[220px_minmax(0,1fr)]">
        ${accountMenuMarkup(active)}
        <div class="grid min-w-0 gap-5">${panel}</div>
      </main>
      ${renderToast()}
      ${renderFooter()}
    </div>
  `;
}

export async function mountAccountPage(
  app: HTMLElement,
  bindNavigation: () => void,
  navigate: (route: string) => void,
  // The section of the route that was opened.
  active: AccountSection = 'account'
): Promise<void> {
  const user = getCurrentUser();
  if (!user) {
    app.innerHTML = `
      <div class="mx-auto max-w-[var(--page-width)] px-5 pt-6 pb-16">
        ${renderHeader('/account')}
        <main class="grid gap-5">
          <section class="grid gap-3 rounded-[22px] border border-border bg-panel p-6 text-center shadow-card">
            <p class="m-0 text-muted">${t('loginRequired')}</p>
            <button class="mx-auto cursor-pointer rounded-full border border-primary bg-primary px-4 py-2.5 text-white" type="button" data-go-login>${t('loginRequiredAction')}</button>
          </section>
        </main>
        ${renderFooter()}
      </div>
    `;
    document.querySelector('[data-go-login]')?.addEventListener('click', () => navigate('/login'));
    bindNavigation();
    return;
  }

  let polls: UserPoll[] = [];
  let comments: UserComment[] = [];
  let pollPage = 1;
  let commentPage = 1;
  let pollHasMore = false;
  let commentHasMore = false;
  let pollError = '';
  let commentError = '';
  let hasRecoveryCode = false;

  // Only the open section loads its own first page.
  if (active === 'polls') {
    try {
      const result = await getUserPolls(1);
      polls = result.polls;
      pollPage = result.page;
      pollHasMore = result.hasMore;
    } catch (error) {
      pollError = getErrorMessage(error);
    }
  } else if (active === 'comments') {
    try {
      const result = await getUserComments(1);
      comments = result.comments;
      commentPage = result.page;
      commentHasMore = result.hasMore;
    } catch (error) {
      commentError = getErrorMessage(error);
    }
  } else {
    try {
      hasRecoveryCode = await getRecoveryCodeStatus();
    } catch {
      hasRecoveryCode = false;
    }
  }

  const render = () => {
    const panels: Record<AccountSection, string> = {
      account: accountPanelMarkup(user, hasRecoveryCode),
      polls: accountPollsPanelMarkup(polls, pollHasMore, pollError),
      comments: accountCommentsPanelMarkup(comments, commentHasMore, commentError)
    };
    app.innerHTML = accountDashboardMarkup(active, panels[active]);
    bindHandlers();
  };

  const loadMorePolls = async (button: HTMLButtonElement) => {
    button.disabled = true;
    try {
      const result = await getUserPolls(pollPage + 1);
      polls = [...polls, ...result.polls];
      pollPage = result.page;
      pollHasMore = result.hasMore;

      render();
    } catch (error) {
      showToast(`${t('accountActionFailed')} ${getErrorMessage(error)}`, 'error');
      button.disabled = false;
    }
  };

  const loadMoreComments = async (button: HTMLButtonElement) => {
    button.disabled = true;
    try {
      const result = await getUserComments(commentPage + 1);
      comments = [...comments, ...result.comments];
      commentPage = result.page;
      commentHasMore = result.hasMore;
      render();
    } catch (error) {
      showToast(`${t('accountActionFailed')} ${getErrorMessage(error)}`, 'error');
      button.disabled = false;
    }
  };


  const bindHandlers = () => {
    document.querySelector('[data-regenerate-recovery]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      const currentPassword = window.prompt(t('accountPasswordPrompt')) ?? '';
      if (!currentPassword) return;
      button.disabled = true;
      try {
        const code = await regenerateRecoveryCode(currentPassword);
        const output = document.querySelector<HTMLElement>('[data-recovery-output]');
        if (output) output.innerHTML = renderRecoveryCode(code);
        showToast(t('recoveryCodeRegenerated'));
      } catch (error) {
        showToast(`${t('accountActionFailed')} ${getErrorMessage(error)}`, 'error');
      } finally {
        button.disabled = false;
      }
    });

    document.querySelector('[data-logout-all]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      button.disabled = true;
      try {
        await logoutAllDevices();
        showToast(t('accountLogoutAllDone'));
        navigate('/login');
      } catch (error) {
        showToast(`${t('accountActionFailed')} ${getErrorMessage(error)}`, 'error');
        button.disabled = false;
      }
    });

    document.querySelector('[data-delete-account]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      if (!window.confirm(t('accountDeleteConfirm'))) return;
      const currentPassword = window.prompt(t('accountPasswordPrompt')) ?? '';
      if (!currentPassword) return;
      button.disabled = true;
      try {
        await deleteAccount(currentPassword);
        showToast(t('accountDeleted'));
        navigate('/');
      } catch (error) {
        showToast(`${t('accountActionFailed')} ${getErrorMessage(error)}`, 'error');
        button.disabled = false;
      }
    });

    document.querySelector('[data-logout]')?.addEventListener('click', async () => {
      try {
        await logoutUser();
        showToast(t('logoutDone'));
        navigate('/login');
      } catch (error) {
        showToast(`${t('accountActionFailed')} ${getErrorMessage(error)}`, 'error');
      }
    });


    document.querySelectorAll<HTMLButtonElement>('[data-close-poll]').forEach((button) => {
      button.addEventListener('click', async () => {
        const pollId = Number(button.dataset.closePoll);
        button.disabled = true;
        try {
          await closeUserPoll(pollId);
          polls = polls.map((poll) => (poll.id === pollId ? { ...poll, status: 'closed' as const } : poll));
          showToast(t('accountClosed'));
          render();
        } catch (error) {
          showToast(`${t('accountActionFailed')} ${getErrorMessage(error)}`, 'error');
          button.disabled = false;
        }
      });
    });

    document.querySelectorAll<HTMLButtonElement>('[data-delete-poll]').forEach((button) => {
      button.addEventListener('click', async () => {
        const pollId = Number(button.dataset.deletePoll);
        button.disabled = true;
        try {
          await deleteUserPoll(pollId);
          polls = polls.filter((poll) => poll.id !== pollId);
          showToast(t('accountWithdrawn'));
          render();
        } catch (error) {
          showToast(`${t('accountActionFailed')} ${getErrorMessage(error)}`, 'error');
          button.disabled = false;
        }
      });
    });

    document.querySelectorAll<HTMLButtonElement>('[data-delete-comment]').forEach((button) => {
      button.addEventListener('click', async () => {
        const id = button.dataset.deleteComment ?? '';
        button.disabled = true;
        try {
          await deleteUserComment(id);
          comments = comments.filter((comment) => comment.id !== id);
          showToast(t('accountCommentDeleted'));
          render();
        } catch (error) {
          showToast(`${t('accountActionFailed')} ${getErrorMessage(error)}`, 'error');
          button.disabled = false;
        }
      });
    });

    document.querySelector<HTMLButtonElement>('[data-load-more-polls]')?.addEventListener('click', (event) => {
      void loadMorePolls(event.currentTarget as HTMLButtonElement);
    });

    document.querySelector<HTMLButtonElement>('[data-load-more-comments]')?.addEventListener('click', (event) => {
      void loadMoreComments(event.currentTarget as HTMLButtonElement);
    });
  };

  render();
  bindNavigation();
}
