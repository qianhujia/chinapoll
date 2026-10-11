import {
  closeUserPoll,
  deleteUserComment,
  deleteUserPoll,
  getCurrentUser,
  getRecoveryCodeStatus,
  getUserComments,
  getUserPolls,
  logoutUser,
  regenerateRecoveryCode,
  type UserComment,
  type UserPoll
} from '../lib/session';
import { escapeHtml, getErrorMessage, renderFooter, renderHeader, renderRecoveryCode, renderToast, showToast, t } from '../ui';

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
        <a class="font-semibold text-primary hover:underline" href="/poll/${poll.id}" data-route="/poll/${poll.id}">#${poll.id} ${escapeHtml(poll.title ?? '')}</a>
        <span class="text-xs text-muted">${statusLabel(poll.status)} · ${escapeHtml(poll.createdAt)}</span>
      </div>
      <div class="flex items-center gap-2">${actions}</div>
    </li>
  `;
}

function commentCardMarkup(comment: UserComment): string {
  return `
    <li class="flex flex-wrap items-start justify-between gap-3 border-b border-border py-3.5">
      <div class="grid gap-1">
        <a class="font-semibold text-primary hover:underline" href="/poll/${comment.pollId}" data-route="/poll/${comment.pollId}">#${comment.pollId} ${escapeHtml(comment.pollTitle ?? '')}</a>
        <p class="m-0 whitespace-pre-wrap [overflow-wrap:anywhere]">${escapeHtml(comment.comment)}</p>
        <span class="text-xs text-muted">${escapeHtml(comment.createdAt)}</span>
      </div>
      <button class="cursor-pointer rounded-full border border-border bg-panel px-3 py-1.5 text-sm text-ink hover:border-[#d95b5b] hover:text-[#d95b5b]" type="button" data-delete-comment="${comment.id}">${t('accountDeleteComment')}</button>
    </li>
  `;
}

export async function mountAccountPage(
  app: HTMLElement,
  bindNavigation: () => void,
  navigate: (route: string) => void
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
  let hasRecoveryCode = false;
  let loadError = '';
  try {
    [polls, comments] = await Promise.all([
      getUserPolls().then((response) => response.polls),
      getUserComments().then((response) => response.comments)
    ]);
  } catch (error) {
    loadError = getErrorMessage(error);
  }
  try {
    hasRecoveryCode = await getRecoveryCodeStatus();
  } catch {
    hasRecoveryCode = false;
  }

  app.innerHTML = `
    <div class="mx-auto max-w-[var(--page-width)] px-5 pt-6 pb-16">
      ${renderHeader('/account')}
      <main class="grid gap-5">
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
          <p class="m-0 rounded-[14px] border border-[#f0c36d] bg-[#fff7e6] px-3.5 py-3 text-sm text-ink" role="note">${t('recoveryCodeRegenerateNote')}</p>
          <div>
            <button class="cursor-pointer rounded-full border border-border bg-panel px-3.5 py-2 text-sm text-ink hover:border-primary hover:text-primary" type="button" data-regenerate-recovery>${t('recoveryCodeRegenerate')}</button>
          </div>
          <div data-recovery-output></div>
        </section>

        <section class="rounded-[22px] border border-border bg-panel p-6 shadow-card">
          <h2 class="mb-3.5 text-xl font-bold">${t('accountPollsTitle')}</h2>
          ${loadError ? `<p class="m-0 text-muted">${escapeHtml(t('accountLoadFailed'))} ${escapeHtml(loadError)}</p>`
            : polls.length
              ? `<ul class="m-0 grid list-none gap-0 p-0">${polls.map(pollCardMarkup).join('')}</ul>`
              : `<p class="m-0 text-muted">${t('accountNoPolls')}</p>`}
        </section>

        <section class="rounded-[22px] border border-border bg-panel p-6 shadow-card">
          <h2 class="mb-3.5 text-xl font-bold">${t('accountCommentsTitle')}</h2>
          ${loadError ? ''
            : comments.length
              ? `<ul class="m-0 grid list-none gap-0 p-0">${comments.map(commentCardMarkup).join('')}</ul>`
              : `<p class="m-0 text-muted">${t('accountNoComments')}</p>`}
        </section>
      </main>
      ${renderToast()}
      ${renderFooter()}
    </div>
  `;

  document.querySelector('[data-regenerate-recovery]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    try {
      const code = await regenerateRecoveryCode();
      const output = document.querySelector<HTMLElement>('[data-recovery-output]');
      if (output) output.innerHTML = renderRecoveryCode(code);
      showToast(t('recoveryCodeRegenerated'));
    } catch (error) {
      showToast(`${t('accountActionFailed')} ${getErrorMessage(error)}`, 'error');
    } finally {
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
      button.disabled = true;
      try {
        await closeUserPoll(Number(button.dataset.closePoll));
        showToast(t('accountClosed'));
        await mountAccountPage(app, bindNavigation, navigate);
      } catch (error) {
        showToast(`${t('accountActionFailed')} ${getErrorMessage(error)}`, 'error');
        button.disabled = false;
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-delete-poll]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await deleteUserPoll(Number(button.dataset.deletePoll));
        showToast(t('accountWithdrawn'));
        await mountAccountPage(app, bindNavigation, navigate);
      } catch (error) {
        showToast(`${t('accountActionFailed')} ${getErrorMessage(error)}`, 'error');
        button.disabled = false;
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-delete-comment]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await deleteUserComment(Number(button.dataset.deleteComment));
        showToast(t('accountCommentDeleted'));
        await mountAccountPage(app, bindNavigation, navigate);
      } catch (error) {
        showToast(`${t('accountActionFailed')} ${getErrorMessage(error)}`, 'error');
        button.disabled = false;
      }
    });
  });

  bindNavigation();
}
