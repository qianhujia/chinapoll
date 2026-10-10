import { claimProposal, submitProposal } from '../lib/poll';
import { getErrorMessage, renderFooter, renderHeader, t } from '../ui';

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
      ${renderFooter()}
    </div>
  `;
  bindNavigation();
}

export function mountProposePage(app: HTMLElement, bindNavigation: () => void): void {
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
              <label class="grid gap-2" for="proposal-email">${t('proposalEmailLabel')}
                <input class="w-full rounded-[14px] border border-border bg-[#f9fbff] px-3.5 py-3" id="proposal-email" name="email" type="email" autocomplete="email">
              </label>
              <small class="-mt-1.5 text-xs leading-[1.45] text-muted">${t('proposalEmailNote')}</small>
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
            <p class="m-0 min-h-5 text-muted" data-proposal-status role="status" aria-live="polite"></p>
          </form>
        </section>
      </main>
      ${renderFooter()}
    </div>
  `;

  const proposalForm = document.querySelector<HTMLFormElement>('[data-proposal-form]');
  const proposalStatus = document.querySelector('[data-proposal-status]');
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
    const email = String(formData.get('email') ?? '').trim();
    const submitButton = proposalForm.querySelector<HTMLButtonElement>('button[type="submit"]')!;
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
        proposalStatus.textContent = `${t('proposalSubmitted')}: ${result.pollId} · ${submitter}`;
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

export function mountClaimProposalPage(app: HTMLElement, bindNavigation: () => void): void {
  app.innerHTML = `
    <div class="mx-auto max-w-[var(--page-width)] px-5 pt-6 pb-16">
      ${renderHeader('/submit')}
      <main class="grid gap-5">
        <section class="grid gap-3 rounded-[22px] border border-border bg-panel p-6 shadow-card">
          <h1 class="m-0 text-2xl font-bold">${t('claimProposalTitle')}</h1>
          <p class="m-0 text-muted">${t('claimProposalDescription')}</p>
          <form class="grid gap-3" data-claim-form>
            <label class="grid gap-2" for="claim-poll-id">${t('claimPollIdLabel')}
              <input class="w-full rounded-[14px] border border-border bg-[#f9fbff] px-3.5 py-3" id="claim-poll-id" name="pollId" type="text" inputmode="numeric" placeholder="47" required>
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

  const claimForm = document.querySelector<HTMLFormElement>('[data-claim-form]');
  const claimStatus = document.querySelector('[data-claim-status]');
  claimForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(claimForm);
    const pollId = String(formData.get('pollId') ?? '').trim();
    const email = String(formData.get('email') ?? '').trim();
    const submitButton = claimForm.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    submitButton.disabled = true;
    if (claimStatus) claimStatus.textContent = '';

    try {
      const result = await claimProposal(pollId, email);
      if (claimStatus) claimStatus.textContent = `${t('claimConfirmed')}: ${result.pollId} · ${result.submitter}`;
    } catch (error) {
      if (claimStatus) claimStatus.textContent = `${t('claimFailed')} ${getErrorMessage(error)}`;
    } finally {
      submitButton.disabled = false;
    }
  });

  bindNavigation();
}
