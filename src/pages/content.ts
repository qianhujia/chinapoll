import { submitProposal } from '../lib/poll';
import { getCurrentUser } from '../lib/session';
import { getErrorMessage, renderFooter, renderHeader, renderToast, showToast, t } from '../ui';

export function mountAboutPage(app: HTMLElement, bindNavigation: () => void): void {
  app.innerHTML = `
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
      ${renderToast()}
      ${renderFooter()}
    </div>
  `;
  bindNavigation();
}

export function mountProposePage(app: HTMLElement, bindNavigation: () => void): void {
  if (!getCurrentUser()) {
    app.innerHTML = `
      <div class="mx-auto max-w-[var(--page-width)] px-5 pt-6 pb-16">
        ${renderHeader('/submit')}
        <main class="grid gap-5">
          <section class="grid gap-3 rounded-[22px] border border-border bg-panel p-6 text-center shadow-card">
            <p class="m-0 text-muted">${t('proposalLoginRequired')}</p>
            <a class="mx-auto cursor-pointer rounded-full border border-primary bg-primary px-4 py-2.5 text-white no-underline" href="/login" data-route="/login">${t('loginRequiredAction')}</a>
          </section>
        </main>
        ${renderFooter()}
      </div>
    `;
    bindNavigation();
    return;
  }

  app.innerHTML = `
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
          </form>
        </section>
      </main>
      ${renderToast()}
      ${renderFooter()}
    </div>
  `;

  const proposalForm = document.querySelector<HTMLFormElement>('[data-proposal-form]');
  const proposalSchedule = proposalForm?.querySelector<HTMLDivElement>('[data-proposal-schedule]');
  const proposalStart = proposalForm?.querySelector<HTMLInputElement>('[name="startAt"]');
  const proposalEnd = proposalForm?.querySelector<HTMLInputElement>('[name="endAt"]');
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
    const submitButton = proposalForm.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    submitButton.disabled = true;

    try {
      const result = await submitProposal({
        title,
        description: description || undefined,
        mode,
        startAt: mode === 'deadline' ? new Date(startAt).toISOString() : undefined,
        endAt: mode === 'deadline' ? new Date(endAt).toISOString() : undefined
      });
      if (result.status === 'open') {
        showToast(`${t('proposalPublished')}: ${result.pollId}`);
      } else {
        showToast(`${t('proposalSubmitted')}: ${result.pollId}`);
      }
      proposalForm.reset();
      updateProposalSchedule(false);
    } catch (error) {
      showToast(`${t('proposalSubmitFailed')} ${getErrorMessage(error)}`, 'error');
    } finally {
      submitButton.disabled = false;
    }
  });

  bindNavigation();
}



