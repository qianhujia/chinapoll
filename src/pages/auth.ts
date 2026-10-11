import { loginUser, recoverPassword, registerUser } from '../lib/session';
import { escapeHtml, getErrorMessage, renderFooter, renderHeader, renderRecoveryCode, renderToast, showToast, t } from '../ui';
import { getPublicSettings } from '../config';

// Re-renders the current route after a state change by replaying the router's
// popstate handler.
function navigate(route: string): void {
  window.history.pushState({}, '', route);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function fieldMarkup(id: string, name: string, label: string, type: string, autocomplete: string): string {
  return `
    <label class="grid gap-2" for="${id}">${escapeHtml(label)}
      <input class="w-full rounded-[14px] border border-border bg-[#f9fbff] px-3.5 py-3" id="${id}" name="${name}" type="${type}" autocomplete="${autocomplete}" required>
    </label>
  `;
}

export function mountLoginPage(app: HTMLElement, bindNavigation: () => void): void {
  app.innerHTML = `
    <div class="mx-auto max-w-[var(--page-width)] px-5 pt-6 pb-16">
      ${renderHeader('/login')}
      <main class="grid gap-5">
        <section class="grid gap-3 rounded-[22px] border border-border bg-panel p-6 shadow-card">
          <h1 class="m-0 text-2xl font-bold">${t('loginTitle')}</h1>
          <p class="m-0 text-muted">${t('loginBody')}</p>
          <form class="grid gap-3" data-login-form>
            ${fieldMarkup('login-username', 'username', t('username'), 'text', 'username')}
            ${fieldMarkup('login-password', 'password', t('password'), 'password', 'current-password')}
            <button class="mx-auto mt-2 cursor-pointer rounded-full border border-primary bg-primary px-4 py-2.5 text-white" type="submit">${t('loginSubmit')}</button>
          </form>
          <p class="m-0 text-center text-sm text-muted"><a class="text-primary hover:underline" href="/register" data-route="/register">${t('registerLink')}</a></p>
          <p class="m-0 text-center text-sm text-muted"><a class="text-primary hover:underline" href="/reset" data-route="/reset">${t('forgotPassword')}</a></p>
        </section>
      </main>
      ${renderToast()}
      ${renderFooter()}
    </div>
  `;

  const form = document.querySelector<HTMLFormElement>('[data-login-form]');
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const username = String(formData.get('username') ?? '').trim();
    const password = String(formData.get('password') ?? '');
    const submitButton = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    submitButton.disabled = true;
    try {
      const user = await loginUser(username, password);
      showToast(`${t('loginSuccess')}: ${user.username}`);
      navigate('/account');
    } catch (error) {
      showToast(`${t('loginFailed')} ${getErrorMessage(error)}`, 'error');
    } finally {
      submitButton.disabled = false;
    }
  });

  bindNavigation();
}

export function mountRegisterPage(app: HTMLElement, bindNavigation: () => void): void {
  app.innerHTML = `
    <div class="mx-auto max-w-[var(--page-width)] px-5 pt-6 pb-16">
      ${renderHeader('/register')}
      <main class="grid gap-5">
        <section class="grid gap-3 rounded-[22px] border border-border bg-panel p-6 shadow-card">
          <h1 class="m-0 text-2xl font-bold">${t('registerTitle')}</h1>
          <div class="m-0 grid gap-1 rounded-[14px] border border-[#f0c36d] bg-[#fff7e6] px-3.5 py-3 text-sm text-ink" role="note">
            <strong>${t('registerNoticeTitle')}</strong>
            <ol class="m-0 list-decimal pl-5 space-y-1">
              <li>${t('registerWarning')}</li>
              <li>${t('registerPrivacyWarning')}</li>
            </ol>
          </div>
          <form class="grid gap-3" data-register-form>
            ${fieldMarkup('register-username', 'username', t('username'), 'text', 'username')}
            ${fieldMarkup('register-password', 'password', t('password'), 'password', 'new-password')}
            ${fieldMarkup('register-confirm', 'confirmPassword', t('confirmPassword'), 'password', 'new-password')}
            <label class="flex items-start gap-2 text-sm text-muted" for="register-ack">
              <input class="mt-1 accent-primary" id="register-ack" name="acknowledge" type="checkbox" required>
              <span>${t('registerAcknowledge')}</span>
            </label>
            <button class="mx-auto mt-2 cursor-pointer rounded-full border border-primary bg-primary px-4 py-2.5 text-white" type="submit">${t('registerSubmit')}</button>
          </form>
          <p class="m-0 text-center text-sm text-muted"><a class="text-primary hover:underline" href="/login" data-route="/login">${t('loginLink')}</a></p>
        </section>
      </main>
      ${renderToast()}
      ${renderFooter()}
    </div>
  `;

  const minLength = 8;
  const form = document.querySelector<HTMLFormElement>('[data-register-form]');
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const username = String(formData.get('username') ?? '').trim();
    const password = String(formData.get('password') ?? '');
    const confirmPassword = String(formData.get('confirmPassword') ?? '');
    if (password.length < minLength) {
      showToast(t('passwordInvalid'), 'error');
      return;
    }
    if (password !== confirmPassword) {
      showToast(t('passwordMismatch'), 'error');
      return;
    }

    const submitButton = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    submitButton.disabled = true;
    try {
      const { user, recoveryCode } = await registerUser(username, password);
      // Show the recovery code before the user can leave this page.
      renderRecoveryCodeStep(app, recoveryCode, t('recoveryCodeContinue'), '/account', bindNavigation);
      showToast(`${t('registerSuccess')}: ${user.username}`);
    } catch (error) {
      showToast(`${t('registerFailed')} ${getErrorMessage(error)}`, 'error');
      submitButton.disabled = false;
    }
  });

  // Keep the configured poll/comment delays visible on the sign-up form.
  const settings = getPublicSettings();
  if (settings.user_poll_delay_hours > 0 || settings.user_comment_delay_hours > 0) {
    const note = document.createElement('p');
    note.className = 'm-0 text-center text-xs text-muted';
    note.textContent = `${t('registerDelayNote')} ${settings.user_poll_delay_hours}h / ${settings.user_comment_delay_hours}h`;
    form?.insertAdjacentElement('afterend', note);
  }

  bindNavigation();
}
// Shown right after sign-up or a password reset: the recovery code is visible
// exactly once, so the user is nudged to copy it before continuing.
function renderRecoveryCodeStep(
  app: HTMLElement,
  code: string,
  continueLabel: string,
  continueRoute: string,
  bindNavigation: () => void
): void {
  app.innerHTML = `
    <div class="mx-auto max-w-[var(--page-width)] px-5 pt-6 pb-16">
      ${renderHeader(continueRoute)}
      <main class="grid gap-5">
        <section class="grid gap-4 rounded-[22px] border border-border bg-panel p-6 shadow-card">
          ${renderRecoveryCode(code)}
          <div class="flex flex-wrap items-center gap-3">
            <button class="cursor-pointer rounded-full border border-border bg-panel px-4 py-2.5 text-sm text-ink hover:border-primary hover:text-primary" type="button" data-copy-recovery>${t('recoveryCodeCopy')}</button>
            <button class="cursor-pointer rounded-full border border-primary bg-primary px-4 py-2.5 text-white" type="button" data-continue-account>${continueLabel}</button>
          </div>
        </section>
      </main>
      ${renderToast()}
      ${renderFooter()}
    </div>
  `;

  document.querySelector('[data-copy-recovery]')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code);
      showToast(t('recoveryCodeCopied'));
    } catch {
      showToast(t('recoveryCodeCopyFailed'), 'error');
    }
  });
  document.querySelector('[data-continue-account]')?.addEventListener('click', () => navigate(continueRoute));
  bindNavigation();
}

export function mountResetPage(app: HTMLElement, bindNavigation: () => void): void {
  app.innerHTML = `
    <div class="mx-auto max-w-[var(--page-width)] px-5 pt-6 pb-16">
      ${renderHeader('/reset')}
      <main class="grid gap-5">
        <section class="grid gap-3 rounded-[22px] border border-border bg-panel p-6 shadow-card">
          <h1 class="m-0 text-2xl font-bold">${t('resetTitle')}</h1>
          <p class="m-0 text-muted">${t('resetBody')}</p>
          <form class="grid gap-3" data-reset-form>
            ${fieldMarkup('reset-username', 'username', t('username'), 'text', 'username')}
            ${fieldMarkup('reset-code', 'code', t('recoveryCodeLabel'), 'text', 'off')}
            ${fieldMarkup('reset-password', 'password', t('password'), 'password', 'new-password')}
            ${fieldMarkup('reset-confirm', 'confirmPassword', t('confirmPassword'), 'password', 'new-password')}
            <button class="mx-auto mt-2 cursor-pointer rounded-full border border-primary bg-primary px-4 py-2.5 text-white" type="submit">${t('resetSubmit')}</button>
          </form>
          <p class="m-0 text-center text-sm text-muted"><a class="text-primary hover:underline" href="/login" data-route="/login">${t('loginLink')}</a></p>
        </section>
      </main>
      ${renderToast()}
      ${renderFooter()}
    </div>
  `;

  const minLength = 8;
  const form = document.querySelector<HTMLFormElement>('[data-reset-form]');
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const username = String(formData.get('username') ?? '').trim();
    const code = String(formData.get('code') ?? '').trim();
    const password = String(formData.get('password') ?? '');
    const confirmPassword = String(formData.get('confirmPassword') ?? '');
    if (!username || !code) {
      showToast(t('resetMissingFields'), 'error');
      return;
    }
    if (password.length < minLength) {
      showToast(t('passwordInvalid'), 'error');
      return;
    }
    if (password !== confirmPassword) {
      showToast(t('passwordMismatch'), 'error');
      return;
    }

    const submitButton = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    submitButton.disabled = true;
    try {
      const recoveryCode = await recoverPassword(username, code, password);
      // The reset rotates the code, so the new one is shown once here too.
      renderRecoveryCodeStep(app, recoveryCode, t('recoveryCodeContinueLogin'), '/login', bindNavigation);
      showToast(t('resetSuccess'));
    } catch (error) {
      showToast(`${t('resetFailed')} ${getErrorMessage(error)}`, 'error');
    } finally {
      submitButton.disabled = false;
    }
  });

  bindNavigation();
}
