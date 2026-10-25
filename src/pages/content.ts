import {
  categoryFieldMarkup,
  descriptionFieldMarkup,
  durationFieldMarkup,
  optionsFieldsetMarkup,
  pollTypeCard,
  proposalRulesMarkup
} from './proposal';
import { ABOUT_SECTIONS, type AboutSection } from '../../shared/about';
import { bindProposalForm } from './proposalForm';
import { getCurrentUser } from '../lib/session';
import { renderFooter, renderHeader, renderToast, t } from '../ui';


// One About section: a heading and its bullet points, both translated.
function aboutSectionMarkup(section: AboutSection): string {
  return `
        <section class="rounded-[22px] border border-border bg-panel p-6 shadow-card">
          <h2 class="mt-0 mb-3 text-xl font-bold">${t(section.title)}</h2>
          <ul class="m-0 list-disc space-y-2 pl-6 text-muted">
            ${section.points.map((key) => `<li>${t(key)}</li>`).join('')}
          </ul>
        </section>
  `;
}

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
          <p class="mt-4 mb-0 text-sm text-muted">${t('aiPrivacyNote')}</p>
        </section>
        ${ABOUT_SECTIONS.map(aboutSectionMarkup).join('')}
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
          ${proposalRulesMarkup()}
          <form class="grid gap-3" data-proposal-form>
            <fieldset class="m-0 grid gap-2 border-0 p-0">
              <legend class="mb-2 font-bold">${t('pollTypeLabel')}</legend>
              <div class="grid gap-2.5 sm:grid-cols-3">
                ${pollTypeCard('verdict', 'pollTypeVerdict', 'pollTypeVerdictHint', true)}
                ${pollTypeCard('single_choice', 'pollTypeSingleChoice', 'pollTypeSingleChoiceHint', false)}
                ${pollTypeCard('multi_choice', 'pollTypeMultiChoice', 'pollTypeMultiChoiceHint', false)}
              </div>
            </fieldset>

            <label class="grid gap-2 font-bold" for="proposal-title">${t('proposalTitleLabel')}
              <input class="w-full rounded-[14px] border border-border bg-[#f9fbff] px-3.5 py-3 font-normal" id="proposal-title" name="title" type="text" maxlength="200" required>
            </label>

            ${optionsFieldsetMarkup()}

            ${durationFieldMarkup()}

            ${categoryFieldMarkup()}

            ${descriptionFieldMarkup()}

            <button class="mx-auto mt-2 cursor-pointer rounded-full border border-primary bg-primary px-4 py-2.5 text-white" type="submit">${t('submitProposal')}</button>
          </form>
        </section>
      </main>
      ${renderToast()}
      ${renderFooter()}
    </div>
  `;

  bindProposalForm(app, bindNavigation);
  bindNavigation();
}
