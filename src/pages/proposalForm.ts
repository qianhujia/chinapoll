// Proposal form behaviour: the options editor, the confirmation step, and the
// final submission.
//
// The client rules mirror `validateProposal` in worker/api/proposal.ts so a
// submission is rejected client-side before it is sent.

import {
  MAX_OPTION_LABEL_LENGTH,
  DURATION_LABEL_KEYS,
  getTopics,
  submitProposal,
  type PollDuration,
  type PollType
} from '../lib/poll';
import { getPublicSettings } from '../config';
import { getErrorMessage, showToast, t } from '../ui';
import {
  DESCRIPTION_MAX_ROWS,
  DESCRIPTION_MIN_ROWS,
  MAX_OPTIONS,
  MIN_OPTIONS,
  confirmationMarkup,
  optionRowMarkup,
  templateOptionLabels
} from './proposal';

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
  /** The poll type the user picked, which names the poll in the summary. */
  pollType: PollType;
  duration: PollDuration;
  description: string;
  options: Array<{ position: number; label: string }>;
}

// The i18n key of the label a poll type is shown under.
function pollTypeLabelKey(pollType: PollType): string {
  if (pollType === 'verdict') return 'pollTypeVerdict';
  return pollType === 'multi_choice' ? 'pollTypeMultiChoice' : 'pollTypeSingleChoice';
}

// Opens the read-only confirmation dialog. The user either goes back to edit or
// confirms, which re-submits the form and sends the request.
export function openConfirmation(
  app: HTMLElement,
  summary: ConfirmationSummary,
  onBack: () => void
): void {
  const typeLabel = t(pollTypeLabelKey(summary.pollType));
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

export function bindProposalForm(app: HTMLElement, bindNavigation: () => void): void {
  const form = app.querySelector<HTMLFormElement>('[data-proposal-form]');
  if (!form) return;

  const titleInput = form.querySelector<HTMLInputElement>('#proposal-title');
  const durationSelect = form.querySelector('#proposal-duration') as HTMLSelectElement | null;
  const descriptionInput = form.querySelector<HTMLTextAreaElement>('#proposal-description');
  const optionsFieldset = form.querySelector<HTMLFieldSetElement>('[data-options-fieldset]');
  const optionRows = form.querySelector<HTMLDivElement>('[data-option-rows]');
  const addOptionButton = form.querySelector<HTMLButtonElement>('[data-add-option]');
  const submitButton = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const categorySelect = form.querySelector('[data-category]') as HTMLSelectElement | null;
  const categoryDescription = form.querySelector<HTMLElement>('[data-category-description]');

  // The card the user picked. Every card maps to a stored poll type, so the form
  // submits it as-is.
  let pollType: PollType = 'verdict';
  // The height the description grows to before it scrolls, measured on first use.
  let descriptionMaxHeight = 0;
  // Set while the confirmation dialog is open so the second submit sends the
  // request instead of opening the dialog again.
  let confirming = false;
  // Store categories with descriptions for lookup when selection changes.
  let categoriesWithDescription: Array<{ slug: string; description: string | null }> = [];

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

  // Fills the editor with the rows the picked type starts from. Every row is
  // editable: the verdict type pre-fills the three verdict words and the user may
  // rename them, drop to two, or add up to seven. The other two types have nothing
  // to pre-fill, so they start with two empty rows.
  const fillTemplateRows = () => {
    const labels = templateOptionLabels(pollType);
    if (labels.length > 0) {
      optionRows?.replaceChildren();
      labels.forEach((label, index) => {
        optionRows?.insertAdjacentHTML('beforeend', optionRowMarkup(index + 1, label));
      });
      return;
    }
    // Leaves whatever the user already wrote alone; switching between the two
    // choice cards keeps it.
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

  form.querySelectorAll<HTMLInputElement>('[data-poll-type]').forEach((radio) => {
    radio.addEventListener('change', () => {
      const next = radio.value as PollType;
      // Leaving the verdict type clears its pre-filled rows, so a single or multiple
      // choice poll starts from an empty list instead of keeping
      // Approve / Neutral / Oppose.
      if (pollType === 'verdict' && next !== 'verdict') optionRows?.replaceChildren();
      pollType = next;
      syncOptionEditor();
    });
  });
  // The topic dropdown is filled from the enabled topics.
  getTopics().then((result) => {
    if (!categorySelect) return;
    const locale = (getPublicSettings().default_locale ?? 'en') as 'en' | 'zh-CN' | 'zh-TW';
    categoriesWithDescription = result.topics.map((topic) => ({
      slug: topic.slug,
      description: topic.description
    }));
    result.topics.forEach((topic) => {
      const option = document.createElement('option');
      option.value = topic.slug;
      option.textContent = topic.names[locale] ?? topic.name;
      categorySelect.appendChild(option);
    });
  }).catch(() => {
    // The dropdown stays at "No category" when the list cannot be loaded.
  });

  categorySelect?.addEventListener('change', () => {
    if (categoryDescription) {
      const selectedSlug = categorySelect.value;
      const category = categoriesWithDescription.find((c) => c.slug === selectedSlug);
      if (category?.description) {
        categoryDescription.textContent = category.description;
        categoryDescription.classList.remove('hidden');
      } else {
        categoryDescription.textContent = '';
        categoryDescription.classList.add('hidden');
      }
    }
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

    // Before the request is sent the summary is shown; `confirming` keeps the
    // second submit (from the dialog) going straight to the server.
    if (!confirming) {
      openConfirmation(app, { title, pollType, duration, description, options }, () => {
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
        options,
        topic: categorySelect?.value || undefined
      });
      showToast(result.status === 'open'
        ? `${t('proposalPublished')}: ${result.pollId}`
        : `${t('proposalSubmitted')}: ${result.pollId}`);
      // The form is reset for another submission.
      confirming = false;
      pollType = 'verdict';
      const verdictRadio = form.querySelector<HTMLInputElement>('[data-poll-type][value="verdict"]');
      if (verdictRadio) verdictRadio.checked = true;
      if (titleInput) titleInput.value = '';
      if (descriptionInput) descriptionInput.value = '';
      // A cleared field shrinks back to its starting rows.
      syncDescriptionHeight();
      if (durationSelect) durationSelect.value = 'none';
      if (categorySelect) {
        categorySelect.value = '';
      }
      if (categoryDescription) {
        categoryDescription.textContent = '';
        categoryDescription.classList.add('hidden');
      }
      rows().forEach((row) => row.remove());
      syncOptionEditor();
    } catch (error) {
      showToast(`${t('proposalSubmitFailed')} ${getErrorMessage(error)}`, 'error');
      confirming = false;
    } finally {
      submitButton.disabled = false;
    }
  });

  bindNavigation();
}
