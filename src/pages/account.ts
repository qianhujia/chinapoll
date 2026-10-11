import {
  closeUserPoll,
  deleteAccount,
  deleteUserPoll,
  getCurrentUser,
  getRecoveryCodeStatus,
  getUserPolls,
  logoutUser,
  regenerateRecoveryCode,
  type UserPoll
} from '../lib/session';
import { forgetMyPoll, getMyPollIds } from '../lib/poll';
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
  let hasRecoveryCode = false;
  let loadError = '';
  try {
    polls = await getUserPolls(getMyPollIds());
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

        <section class="grid gap-3 rounded-[22px] border border-[#e2a9a9] bg-panel p-6 shadow-card">
          <h2 class="m-0 text-xl font-bold">${t('accountDeleteTitle')}</h2>
          <p class="m-0 text-muted">${t('accountDeleteBody')}</p>
          <div>
            <button class="cursor-pointer rounded-full border border-[#d95b5b] bg-panel px-3.5 py-2 text-sm text-[#d95b5b] hover:bg-[#faeaea]" type="button" data-delete-account>${t('accountDeleteAction')}</button>
          </div>
        </section>

        <section class="rounded-[22px] border border-border bg-panel p-6 shadow-card">
          <h2 class="mb-3.5 text-xl font-bold">${t('accountPollsTitle')}</h2>
          ${loadError ? `<p class="m-0 text-muted">${escapeHtml(t('accountLoadFailed'))} ${escapeHtml(loadError)}</p>`
            : polls.length
              ? `<ul class="m-0 grid list-none gap-0 p-0">${polls.map(pollCardMarkup).join('')}</ul>`
              : `<p class="m-0 text-muted">${t('accountNoPolls')}</p>`}
        </section>
      </main>
      ${renderToast()}
      ${renderFooter()}
    </div>
  `;

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
        const pollId = Number(button.dataset.deletePoll);
        await deleteUserPoll(pollId);
        forgetMyPoll(pollId);
        showToast(t('accountWithdrawn'));
        await mountAccountPage(app, bindNavigation, navigate);
      } catch (error) {
        showToast(`${t('accountActionFailed')} ${getErrorMessage(error)}`, 'error');
        button.disabled = false;
      }
    });
  });

  bindNavigation();
}
