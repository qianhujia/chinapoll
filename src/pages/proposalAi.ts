// AI button behaviour for the proposal form.
//
// Both buttons are hidden entirely when the `ai_enable` setting is off, and
// disabled until the title has at least 10 characters. A title suggestion is
// applied only when the user clicks it; an option suggestion fills empty rows
// and keeps a subtle "AI" tag until the row is edited or the poll is submitted.

import { enhanceTitle, suggestOptions, type AiLocale } from '../lib/ai';
import { turnstileToken } from '../lib/turnstile';
import type { PollType } from '../lib/poll';
import { escapeHtml, getErrorMessage, showToast, t } from '../ui';
import { MAX_OPTIONS, MIN_OPTIONS, optionRowMarkup } from './proposal';

export interface AiBinding {
  aiEnabled: boolean;
  locale: AiLocale;
  rows: () => HTMLDivElement[];
  renumber: () => void;
  syncOptionButtons: () => void;
  syncAiGates: () => void;
  currentPollType: () => PollType;
  titleInput: HTMLInputElement | null;
  descriptionInput: HTMLTextAreaElement | null;
  aiSuggestions: HTMLUListElement | null;
  aiDiscardButton: HTMLButtonElement | null;
}

// Wires the "Enhance with AI" and "Suggest options" buttons.
export function bindAiButtons(form: HTMLFormElement, binding: AiBinding): void {
  const {
    aiEnabled, locale, rows, renumber, syncOptionButtons, syncAiGates,
    titleInput, descriptionInput, aiSuggestions, aiDiscardButton
  } = binding;
  if (!aiEnabled) return;

  const enhanceButton = form.querySelector<HTMLButtonElement>('[data-ai-enhance]');
  const optionsButton = form.querySelector<HTMLButtonElement>('[data-ai-options]');

  const renderSuggestions = (suggestions: string[]) => {
    if (!aiSuggestions) return;
    aiSuggestions.innerHTML = suggestions.map((suggestion) => `
      <li class="flex items-center justify-between gap-3 rounded-[14px] border border-border bg-[#f9fbff] px-3.5 py-2.5 text-sm">
        <span class="min-w-0">${escapeHtml(suggestion)}</span>
        <button class="shrink-0 cursor-pointer rounded-full border border-primary bg-primary px-3 py-1.5 text-xs text-white" type="button" data-ai-use="${escapeHtml(suggestion)}">${t('aiUseThis')}</button>
      </li>
    `).join('');
    aiSuggestions.hidden = suggestions.length === 0;
  };

  aiSuggestions?.addEventListener('click', (event) => {
    const use = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-ai-use]');
    if (!use || !titleInput) return;
    // The user's own text is replaced only on an explicit click.
    titleInput.value = use.dataset.aiUse ?? titleInput.value;
    renderSuggestions([]);
    syncAiGates();
  });

  enhanceButton?.addEventListener('click', async () => {
    if (!titleInput || titleInput.value.trim().length < 10) return;
    enhanceButton.disabled = true;
    enhanceButton.textContent = t('aiEnhancing');
    try {
      const result = await enhanceTitle({
        title: titleInput.value.trim(),
        description: descriptionInput?.value.trim() ?? '',
        locale,
        turnstileToken: turnstileToken('ai-enhance')
      });
      renderSuggestions(result.suggestions);
    } catch (error) {
      showToast(`${t('aiFailed')} ${getErrorMessage(error)}`, 'error');
    } finally {
      enhanceButton.textContent = t('aiEnhanceTitle');
      syncAiGates();
    }
  });

  optionsButton?.addEventListener('click', async () => {
    const pollType = binding.currentPollType();
    if (!titleInput) return;
    optionsButton.disabled = true;
    optionsButton.textContent = t('aiEnhancing');
    try {
      const result = await suggestOptions({
        title: titleInput.value.trim(),
        description: descriptionInput?.value.trim() ?? '',
        pollType,
        count: Math.max(MIN_OPTIONS, rows().length),
        locale,
        turnstileToken: turnstileToken('ai-options')
      });
      // Suggestions fill the empty rows first and keep a subtle "AI" tag until
      // the user edits them or submits the poll.
      result.options.forEach((label) => {
        const target = rows().find((row) =>
          (row.querySelector<HTMLInputElement>('[data-option-label]')?.value.trim() ?? '') === '');
        if (target) {
          const input = target.querySelector<HTMLInputElement>('[data-option-label]');
          if (input) input.value = label;
          target.dataset.suggested = '1';
          if (!target.querySelector('[data-ai-tag]')) {
            target.insertAdjacentHTML(
              'afterbegin',
              `<span class="shrink-0 rounded-full bg-[#eef3fb] px-2 py-0.5 text-xs text-muted" data-ai-tag>${t('aiTag')}</span>`
            );
          }
        } else if (rows().length < MAX_OPTIONS) {
          form.querySelector<HTMLDivElement>('[data-option-rows]')
            ?.insertAdjacentHTML('beforeend', optionRowMarkup(rows().length + 1, label, true));
        }
      });
      renumber();
      syncOptionButtons();
      if (aiDiscardButton) aiDiscardButton.hidden = false;
    } catch (error) {
      showToast(`${t('aiFailed')} ${getErrorMessage(error)}`, 'error');
    } finally {
      optionsButton.textContent = t('aiSuggestOptions');
      syncAiGates();
    }
  });

  aiDiscardButton?.addEventListener('click', () => {
    rows().forEach((row) => {
      if (row.dataset.suggested !== '1') return;
      const input = row.querySelector<HTMLInputElement>('[data-option-label]');
      if (input) input.value = '';
      delete row.dataset.suggested;
      row.querySelector('[data-ai-tag]')?.remove();
    });
    if (aiDiscardButton) aiDiscardButton.hidden = true;
    syncOptionButtons();
  });
}
