// Proposal form behaviour: the options editor, the AI buttons, the
// confirmation step, and the final submission.
//
// The client rules mirror `validateProposal` in worker/api/proposal.ts so a
// submission is rejected client-side before it is sent.

import {
  MAX_OPTION_LABEL_LENGTH,
  DURATION_LABEL_KEYS,
  rememberMyPoll,
  submitProposal,
  type PollDuration,
  type PollType
} from '../lib/poll';
import { getPublicSettings } from '../config';
import { getErrorMessage, showToast, t } from '../ui';
import type { AiLocale } from '../lib/ai';
import {
  DESCRIPTION_MAX_ROWS,
  DESCRIPTION_MIN_ROWS,
  MAX_OPTIONS,
  MIN_OPTIONS,
  VERDICT_TEMPLATE_LABEL_KEYS,
  confirmationMarkup,
  optionRowMarkup,
  type TemplateType
} from './proposal';
import { bindAiButtons } from './proposalAi';

export type OptionRowCheck =
  | { ok: true; options: Array<{ position: number; label: string }> }
  | { ok: false; message: string };

// Applies the server-side option rules: 2 to 7 rows, each 1 to 80 characters
// after trimming, and no duplicates.
export function checkOptionLabels(labels: string[]): OptionRowCheck {
  const trimmed = labels.map((label) => label.trim());
  if (trimmed.length < MIN_OPTIONS || trimmed.length > MAX_OPTIONS) {
    return { ok: false, message: t('optionsCountInvalid') };
  }
  if (trimmed.some((label) => label.length < 1 || label.length > MAX_OPTION_LABEL_LENGTH)) {
    return { ok: false, message: t('optionInvalidLength') };
  }
  const lowered = trimmed.map((label) => label.toLowerCase());
  if (new Set(lowered).size !== lowered.length) {
    return { ok: false, message: t('optionDuplicate') };
  }
  return { ok: true, options: trimmed.map((label, index) => ({ position: index + 1, label })) };
}

export interface ConfirmationSummary {
  title: string;
  /** The card the user picked, which names the poll in the summary. */
  template: TemplateType;
  duration: PollDuration;
  description: string;
  options: Array<{ position: number; label: string }>;
}

// The i18n key of the label a template is shown under.
function templateLabelKey(template: TemplateType): string {
  if (template === 'multi_choice') return 'pollTypeMultiChoice';
  return template === 'single_choice' ? 'pollTypeSingleChoice' : 'pollTypeVerdict';
}

// Opens the read-only confirmation dialog. The user either goes back to edit or
// confirms, which re-submits the form and sends the request.
export function openConfirmation(
  app: HTMLElement,
  summary: ConfirmationSummary,
  onBack: () => void
): void {
  const typeLabel = t(templateLabelKey(summary.template));
  const host = document.createElement('div');
  host.className = 'fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4';
  host.dataset.proposalConfirm = '1';
  host.innerHTML = confirmationMarkup({
    title: summary.title,
    pollTypeLabel: typeLabel,
    durationLabel: t(DURATION_LABEL_KEYS[summary.duration]),
    description: summary.description,
    options: summary.options.map((option) => option.label)
  });
  app.appendChild(host);

  host.querySelector('[data-confirm-back]')?.addEventListener('click', () => {
    host.remove();
    onBack();
  });
  host.querySelector('[data-confirm-submit]')?.addEventListener('click', () => {
    host.remove();
    // Re-submitting the form now sends the request.
    document.querySelector<HTMLFormElement>('[data-proposal-form]')?.requestSubmit();
  });
}

export function bindProposalForm(app: HTMLElement, bindNavigation: () => void, aiEnabled: boolean): void {
  const form = app.querySelector<HTMLFormElement>('[data-proposal-form]');
  if (!form) return;

  const titleInput = form.querySelector<HTMLInputElement>('#proposal-title');
  const durationSelect = form.querySelector('#proposal-duration') as HTMLSelectElement | null;
  const descriptionInput = form.querySelector<HTMLTextAreaElement>('#proposal-description');
  const optionsFieldset = form.querySelector<HTMLFieldSetElement>('[data-options-fieldset]');
  const optionRows = form.querySelector<HTMLDivElement>('[data-option-rows]');
  const addOptionButton = form.querySelector<HTMLButtonElement>('[data-add-option]');
  const aiSuggestions = form.querySelector<HTMLUListElement>('[data-ai-suggestions]');
  const aiDiscardButton = form.querySelector<HTMLButtonElement>('[data-ai-discard]');
  const aiOptionsButton = form.querySelector<HTMLButtonElement>('[data-ai-options]');
  const aiEnhanceButton = form.querySelector<HTMLButtonElement>('[data-ai-enhance]');
  const aiHint = form.querySelector<HTMLElement>('[data-ai-hint]');
  const submitButton = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;

  // The card the user picked. "verdict" is a template, not an API type: it
  // submits as a single choice poll with three pre-filled options.
  let templateType: TemplateType = 'verdict';
  // The height the description grows to before it scrolls, measured on first use.
  let descriptionMaxHeight = 0;
  // Set while the confirmation dialog is open so the second submit sends the
  // request instead of opening the dialog again.
  let confirming = false;

  // The poll type sent to the API for the picked card.
  const apiPollType = (template: TemplateType): PollType =>
    template === 'multi_choice' ? 'multi_choice' : 'single_choice';

  const rows = () => Array.from(optionRows?.querySelectorAll<HTMLDivElement>('[data-option-row]') ?? []);
  const renumber = () => rows().forEach((row, index) => { row.dataset.position = String(index + 1); });
  const syncOptionButtons = () => {
    const count = rows().length;
    if (addOptionButton) addOptionButton.disabled = count >= MAX_OPTIONS;
    rows().forEach((row) => {
      const remove = row.querySelector<HTMLButtonElement>('[data-remove-option]');
      if (remove) remove.disabled = count <= MIN_OPTIONS;
    });
  };
  // The description starts at two rows and grows with the text. Past 30 rows it
  // scrolls instead of growing further, so a long description cannot push the
  // submit button off the page. The row height is measured from the field itself
  // rather than hard-coded, so it follows the real font size and padding.
  const measureLineHeight = () => {
    if (!descriptionInput) return 0;
    const style = getComputedStyle(descriptionInput);
    const padding = Number.parseFloat(style.paddingTop || '0') + Number.parseFloat(style.paddingBottom || '0');
    const height = descriptionInput.style.height;
    descriptionInput.style.height = 'auto';
    // The field is empty here, so `scrollHeight` is the box it renders at its
    // `rows` height; the content is one row per `rows` attribute.
    const oneRow = (Number(descriptionInput.scrollHeight) - padding) / DESCRIPTION_MIN_ROWS;
    descriptionInput.style.height = height;
    return Math.max(oneRow, 1);
  };

  const syncDescriptionHeight = () => {
    if (!descriptionInput) return;
    const style = getComputedStyle(descriptionInput);
    const padding = Number.parseFloat(style.paddingTop || '0') + Number.parseFloat(style.paddingBottom || '0');
    const border = Number.parseFloat(style.borderTopWidth || '0') + Number.parseFloat(style.borderBottomWidth || '0');
    if (descriptionMaxHeight === 0) {
      // `height` is a border-box height, so the borders and the padding are part
      // of the 30-row cap.
      descriptionMaxHeight = measureLineHeight() * DESCRIPTION_MAX_ROWS + padding + border;
    }
    descriptionInput.style.height = 'auto';
    const content = Number(descriptionInput.scrollHeight);
    descriptionInput.style.height = `${Math.min(content, descriptionMaxHeight)}px`;
    descriptionInput.style.overflowY = content > descriptionMaxHeight ? 'auto' : 'hidden';
  };

  descriptionInput?.addEventListener('input', syncDescriptionHeight);
  syncDescriptionHeight();

  const syncAiGates = () => {
    if (!aiEnabled) return;
    const longEnough = (titleInput?.value.trim().length ?? 0) >= 10;
    if (aiEnhanceButton) aiEnhanceButton.disabled = !longEnough;
    if (aiOptionsButton) aiOptionsButton.disabled = !longEnough;
    if (aiHint) aiHint.hidden = longEnough;
  };

  // Fills the editor with the rows the picked card starts from. Every row is
  // editable: the Verdict template only pre-fills the three verdict words and the
  // user may rename them, drop to two, or add up to seven.
  const fillTemplateRows = () => {
    if (templateType === 'verdict') {
      optionRows?.replaceChildren();
      VERDICT_TEMPLATE_LABEL_KEYS.forEach((key, index) => {
        optionRows?.insertAdjacentHTML('beforeend', optionRowMarkup(index + 1, t(key)));
      });
      return;
    }
    // A plain choice poll starts with two empty rows the first time it is picked;
    // switching between the two choice cards keeps what the user already wrote.
    if (rows().length === 0) {
      for (let index = 0; index < MIN_OPTIONS; index += 1) {
        optionRows?.insertAdjacentHTML('beforeend', optionRowMarkup(index + 1));
      }
    }
  };

  const syncOptionEditor = () => {
    if (optionsFieldset) optionsFieldset.hidden = false;
    fillTemplateRows();
    renumber();
    syncOptionButtons();
    syncAiGates();
  };

  syncOptionEditor();

  addOptionButton?.addEventListener('click', () => {
    if (rows().length >= MAX_OPTIONS) return;
    optionRows?.insertAdjacentHTML('beforeend', optionRowMarkup(rows().length + 1));
    renumber();
    syncOptionButtons();
  });

  optionRows?.addEventListener('click', (event) => {
    const remove = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-remove-option]');
    const row = remove?.closest<HTMLDivElement>('[data-option-row]');
    if (!row || remove?.disabled) return;
    if (rows().length <= MIN_OPTIONS) return;
    row.remove();
    renumber();
    syncOptionButtons();
  });

  // Editing a row drops its "AI" tag: the text is the user's from then on.
  optionRows?.addEventListener('input', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLDivElement>('[data-option-row]');
    if (!row || row.dataset.suggested !== '1') return;
    delete row.dataset.suggested;
    row.querySelector('[data-ai-tag]')?.remove();
  });

  form.querySelectorAll<HTMLInputElement>('[data-poll-type]').forEach((radio) => {
    radio.addEventListener('change', () => {
      templateType = radio.value as TemplateType;
      syncOptionEditor();
    });
  });
  titleInput?.addEventListener('input', syncAiGates);

  // The AI buttons are only wired when the setting is on.
  bindAiButtons(form, {
    aiEnabled,
    locale: (getPublicSettings().default_locale ?? 'en') as AiLocale,
    rows,
    renumber,
    syncOptionButtons,
    syncAiGates,
    currentPollType: () => apiPollType(templateType),
    titleInput,
    descriptionInput,
    aiSuggestions,
    aiDiscardButton
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const title = titleInput?.value.trim() ?? '';
    const description = descriptionInput?.value.trim() ?? '';
    const duration = (durationSelect?.value ?? 'none') as PollDuration;

    if (!title || title.length > 200) {
      showToast(t('proposalSubmitFailed'), 'error');
      return;
    }
    if (description.length > 0 && (description.length < 20 || description.length > 2000)) {
      // The field is always visible, so it only needs focus to show what to fix.
      descriptionInput?.focus();
      showToast(t('proposalDescriptionInvalid'), 'error');
      return;
    }

    // Every poll carries its option rows; the confirmation summary shows the
    // same texts.
    const checked = checkOptionLabels(rows().map((row) =>
      row.querySelector<HTMLInputElement>('[data-option-label]')?.value ?? ''));
    if (!checked.ok) {
      showToast(checked.message, 'error');
      return;
    }
    const options = checked.options;
    const pollType = apiPollType(templateType);

    // Before the request is sent the summary is shown; `confirming` keeps the
    // second submit (from the dialog) going straight to the server.
    if (!confirming) {
      openConfirmation(app, { title, template: templateType, duration, description, options }, () => {
        confirming = false;
      });
      confirming = true;
      return;
    }

    submitButton.disabled = true;
    try {
      const result = await submitProposal({
        title,
        description: description || undefined,
        pollType,
        duration,
        options
      });
      showToast(result.status === 'open'
        ? `${t('proposalPublished')}: ${result.pollId}`
        : `${t('proposalSubmitted')}: ${result.pollId}`);
      rememberMyPoll(result.pollId);
      // The form is reset for another submission.
      confirming = false;
      templateType = 'verdict';
      const verdictRadio = form.querySelector<HTMLInputElement>('[data-poll-type][value="verdict"]');
      if (verdictRadio) verdictRadio.checked = true;
      if (titleInput) titleInput.value = '';
      if (descriptionInput) descriptionInput.value = '';
      // A cleared field shrinks back to its starting rows.
      syncDescriptionHeight();
      if (durationSelect) durationSelect.value = 'none';
      rows().forEach((row) => row.remove());
      syncOptionEditor();
      if (aiSuggestions) aiSuggestions.hidden = true;
      if (aiDiscardButton) aiDiscardButton.hidden = true;
      syncAiGates();
    } catch (error) {
      showToast(`${t('proposalSubmitFailed')} ${getErrorMessage(error)}`, 'error');
      confirming = false;
    } finally {
      submitButton.disabled = false;
    }
  });

  bindNavigation();
}
