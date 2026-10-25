import { loginUser, recoverPassword, registerUser } from '../lib/session';
import { escapeHtml, getErrorMessage, renderFooter, renderHeader, renderRecoveryCode, renderToast, showToast, t, viewIconMarkup } from '../ui';
import { getPublicSettings } from '../config';
import { renderTurnstile, resetTurnstile, revealTurnstile, turnstileSiteKey, turnstileToken } from '../lib/turnstile';
import { apiErrorCode } from '../lib/apiError';

// Re-renders the current route after a state change by replaying the router's
// popstate handler.
function navigate(route: string): void {
  window.history.pushState({}, '', route);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function fieldMarkup(id: string, name: string, label: string, type: string, autocomplete: string): string {
  const isPassword = type === 'password';
  const toggleBtn = isPassword
    ? `<button type="button" class="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-ink" aria-label="${t('togglePassword')}" data-toggle-password>${viewIconMarkup('h-5 w-5')}</button>`
    : '';
  return `
    <label class="relative grid gap-2" for="${id}">${escapeHtml(label)}
      <div class="relative">
        <input class="w-full rounded-[14px] border border-border bg-[#f9fbff] px-3.5 py-3 ${isPassword ? 'pr-12' : ''}" id="${id}" name="${name}" type="${type}" autocomplete="${autocomplete}" required>
        ${toggleBtn}
      </div>
    </label>
  `;
}

function bindPasswordToggles(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>('[data-toggle-password]').forEach((btn) => {
    const input = btn.previousElementSibling as HTMLInputElement;
    if (!input || input.tagName !== 'INPUT') return;
    btn.addEventListener('click', () => {
      const isPassword = input.type === 'password';
      input.type = isPassword ? 'text' : 'password';
      btn.setAttribute('aria-label', t(isPassword ? 'hidePassword' : 'togglePassword'));
    });
  });
}

export async function mountLoginPage(app: HTMLElement, bindNavigation: () => void): Promise<void> {
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
            ${turnstileSiteKey() ? '<div class="flex justify-center" data-turnstile-login></div>' : ''}
            <button class="mx-auto mt-2 cursor-pointer rounded-full border border-primary bg-primary px-4 py-2.5 text-white" type="submit">${t('loginSubmit')}</button>
          </form>
          <p class="m-0 text-center text-sm text-muted"><a class="text-primary" href="/register" data-route="/register">${t('registerLink')}</a></p>
          <p class="m-0 text-center text-sm text-muted"><a class="text-primary" href="/reset" data-route="/reset">${t('forgotPassword')}</a></p>
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
      const user = await loginUser(username, password, turnstileToken('login'));
      showToast(`${t('loginSuccess')}: ${user.username}`);
      navigate('/account');
    } catch (error) {
      // The widget is hidden by default, so a verification failure is the only
      // case that must surface the box for the visitor to solve.
      if (apiErrorCode(error) === 'TURNSTILE_FAILED') revealTurnstile('login');
      showToast(`${t('loginFailed')} ${getErrorMessage(error)}`, 'error');
    } finally {
      submitButton.disabled = false;
      resetTurnstile('login');
    }
  });

  const loginWidget = document.querySelector<HTMLElement>('[data-turnstile-login]');
  if (loginWidget) await renderTurnstile('login', loginWidget);

  bindNavigation();

  bindPasswordToggles(app);
}

export async function mountRegisterPage(app: HTMLElement, bindNavigation: () => void): Promise<void> {
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
            ${turnstileSiteKey() ? '<div class="flex justify-center" data-turnstile-register></div>' : ''}
            <button class="mx-auto mt-2 cursor-pointer rounded-full border border-primary bg-primary px-4 py-2.5 text-white" type="submit">${t('registerSubmit')}</button>
          </form>
          <p class="m-0 text-center text-sm text-muted"><a class="text-primary" href="/login" data-route="/login">${t('loginLink')}</a></p>
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
      const { user, recoveryCode } = await registerUser(username, password, turnstileToken('register'));
      // Show the recovery code before the user can leave this page.
      renderRecoveryCodeStep(app, recoveryCode, t('recoveryCodeContinue'), '/account', bindNavigation);
      showToast(`${t('registerSuccess')}: ${user.username}`);
    } catch (error) {
      // The widget is hidden by default, so a verification failure is the only
      // case that must surface the box for the visitor to solve.
      if (apiErrorCode(error) === 'TURNSTILE_FAILED') revealTurnstile('register');
      showToast(`${t('registerFailed')} ${getErrorMessage(error)}`, 'error');
      submitButton.disabled = false;
      resetTurnstile('register');
    }
  });

  // Keep the configured poll/comment delays visible on the sign-up form.
  const settings = getPublicSettings();
  if (settings.user_poll_delay_minutes > 0 || settings.user_comment_delay_minutes > 0) {
    const note = document.createElement('p');
    note.className = 'm-0 text-center text-xs text-muted';
    note.textContent = `${t('registerDelayNote')} ${settings.user_poll_delay_minutes}m / ${settings.user_comment_delay_minutes}m`;
    form?.insertAdjacentElement('afterend', note);
  }

  const registerWidget = document.querySelector<HTMLElement>('[data-turnstile-register]');
  if (registerWidget) await renderTurnstile('register', registerWidget);

  bindNavigation();

  bindPasswordToggles(app);
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
          <p class="m-0 rounded-[14px] border border-[#f0c36d] bg-[#fff7e6] px-3.5 py-3 text-sm text-ink" role="note">${t('recoveryCodeWarning')}</p>
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
          <p class="m-0 text-center text-sm text-muted"><a class="text-primary" href="/login" data-route="/login">${t('loginLink')}</a></p>
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

  bindPasswordToggles(app);
}
