/*
 * Propose page rendering helpers.
 *
 * These helpers are pure string builders; `mountProposePage` assembles them and
 * binds the behaviour. Keeping them separate keeps the form markup readable and
 * lets the option rules live next to the markup they describe.
 */

import {
  DURATION_LABEL_KEYS,
  MAX_OPTION_LABEL_LENGTH,
  MAX_POLL_OPTIONS,
  MIN_POLL_OPTIONS,
  POLL_DURATIONS,
  type PollDuration,
  type PollType
} from '../lib/poll';
import { escapeHtml, t } from '../ui';

// The type cards the form offers. "Verdict" is not an API poll type: choosing it
// submits a single choice poll whose options are pre-filled with the words
// Approve, Neutral, and Oppose, which the user may then edit freely.
export type TemplateType = 'verdict' | 'single_choice' | 'multi_choice';

// i18n keys of the options the Verdict template pre-fills, in row order.
export const VERDICT_TEMPLATE_LABEL_KEYS: ReadonlyArray<string> = ['approve', 'neutral', 'oppose'];

// One selectable card per poll type, with a one-line explanation.
export function pollTypeCard(value: TemplateType, labelKey: string, hintKey: string, checked: boolean): string {
  return `
    <label class="flex cursor-pointer flex-col gap-1 rounded-[14px] border border-border bg-[#f9fbff] px-3.5 py-3">
      <span class="flex items-center gap-2.5">
        <input class="accent-primary" type="radio" name="pollType" value="${value}" data-poll-type${checked ? ' checked' : ''}>
        <span class="font-semibold">${t(labelKey)}</span>
      </span>
      <span class="text-xs text-muted">${t(hintKey)}</span>
    </label>
  `;
}

// A single option row: the label input plus a remove button. A row filled from
// an AI suggestion carries a small "AI" tag until the user edits or submits.
export function optionRowMarkup(position: number, label = '', suggested = false): string {
  return `
    <div class="flex items-center gap-2" data-option-row data-position="${position}"${suggested ? ' data-suggested="1"' : ''}>
      <input class="w-full rounded-[14px] border border-border bg-[#f9fbff] px-3.5 py-3" type="text" maxlength="${MAX_OPTION_LABEL_LENGTH}" value="${escapeHtml(label)}" placeholder="${t('optionPlaceholder')}" data-option-label>
      ${suggested ? `<span class="shrink-0 rounded-full bg-[#eef3fb] px-2 py-0.5 text-xs text-muted" data-ai-tag>${t('aiTag')}</span>` : ''}
      <button class="shrink-0 cursor-pointer rounded-full border border-border bg-panel px-3 py-1.5 text-xs text-muted hover:border-[#d95b5b] hover:text-[#d95b5b]" type="button" data-remove-option>${t('removeOption')}</button>
    </div>
  `;
}

// The options editor. Both poll types fill it with editable rows; the Verdict
// template simply pre-fills three of them, and the neutral row can be removed and
// put back.
export function optionsFieldsetMarkup(): string {
  return `
  <fieldset class="m-0 grid gap-2 border-0 p-0" data-options-fieldset hidden>
    <legend class="mb-2 font-semibold">${t('optionsLabel')}</legend>
    <div class="grid gap-2" data-option-rows></div>
    <div class="flex flex-wrap items-center gap-2.5">
      <button class="cursor-pointer rounded-full border border-border bg-panel px-3.5 py-2 text-sm text-ink disabled:cursor-not-allowed disabled:opacity-60" type="button" data-add-option>${t('addOption')}</button>
      <button class="cursor-pointer rounded-full border border-border bg-panel px-3.5 py-2 text-sm text-ink disabled:cursor-not-allowed disabled:opacity-60" type="button" data-ai-options disabled hidden>${t('aiSuggestOptions')}</button>
      <button class="cursor-pointer text-xs text-primary hover:underline" type="button" data-ai-discard hidden>${t('aiDiscardSuggestions')}</button>
    </div>
  </fieldset>
  `;
}

// The AI block next to the title field: a button, a hint, and the suggestion
// list. It is only rendered when the `ai_enable` setting is on.
export function aiTitleMarkup(): string {
  return `
  <div class="grid gap-2" data-ai-title>
    <div class="flex flex-wrap items-center gap-2.5">
      <button class="cursor-pointer rounded-full border border-border bg-panel px-3.5 py-2 text-sm text-ink disabled:cursor-not-allowed disabled:opacity-60" type="button" data-ai-enhance disabled>${t('aiEnhanceTitle')}</button>
      <span class="text-xs text-muted" data-ai-hint>${t('aiDisabledHint')}</span>
    </div>
    <ul class="m-0 grid list-none gap-2 p-0" data-ai-suggestions hidden></ul>
    <p class="m-0 text-xs text-muted">${t('aiPrivacyNote')}</p>
  </div>
  `;
}

export function aiPrivacyNoteMarkup(): string {
  return `<p class="m-0 text-xs text-muted">${t('aiPrivacyNote')}</p>`;
}

// The duration dropdown, with "No end date" preselected. A poll always has a
// duration, so this is a top-level form field rather than something hidden behind
// a toggle. The mapping is defined in worker/enums.ts and re-exported through
// src/lib/poll.ts.
export function durationFieldMarkup(): string {
  // The option labels are translated here rather than in a module constant:
  // a constant would be built on import, before the locale has been loaded.
  const options = POLL_DURATIONS
    .map((duration) => `<option value="${duration}"${duration === 'none' ? ' selected' : ''}>${t(DURATION_LABEL_KEYS[duration])}</option>`)
    .join('');
  return `
    <label class="grid gap-2" for="proposal-duration">${t('durationLabel')}
      <select class="w-full rounded-[14px] border border-border bg-[#f9fbff] px-3.5 py-3" id="proposal-duration" name="duration">
        ${options}
      </select>
    </label>
  `;
}

// The optional description, collapsed by default so the form stays short. The
// summary names the field, and the label inside it stays available to assistive
// technology once the textarea is revealed.
export function descriptionFieldMarkup(): string {
  return `
    <details class="grid gap-3 rounded-[14px] border border-border bg-[#f9fbff] px-3.5 py-3" data-description-details>
      <summary class="cursor-pointer font-semibold">${t('proposalDescriptionToggle')}</summary>
      <div class="grid gap-3 pt-3">
        <label class="grid gap-2" for="proposal-description">
          <span class="sr-only">${t('proposalDescriptionLabel')}</span>
          <textarea class="min-h-[140px] w-full resize-y rounded-[14px] border border-border bg-white px-3.5 py-3" id="proposal-description" name="description" maxlength="2000"></textarea>
        </label>
      </div>
    </details>
  `;
}

export interface ConfirmationMarkupInput {
  title: string;
  pollTypeLabel: string;
  durationLabel: string;
  description: string;
  options: string[];
}

// The read-only confirmation step: type, title, options, duration, and
// description, shown before the request is sent.
export function confirmationMarkup(summary: ConfirmationMarkupInput): string {
  return `
    <section class="grid max-h-full w-full max-w-[520px] gap-3 overflow-auto rounded-[22px] border border-border bg-panel p-6 shadow-card">
      <h2 class="m-0 text-lg font-bold">${t('confirmTitle')}</h2>
      <dl class="m-0 grid gap-2 text-sm">
        <div class="grid gap-0.5"><dt class="text-muted">${t('confirmType')}</dt><dd class="m-0 font-semibold">${escapeHtml(summary.pollTypeLabel)}</dd></div>
        <div class="grid gap-0.5"><dt class="text-muted">${t('proposalTitleLabel')}</dt><dd class="m-0 font-semibold">${escapeHtml(summary.title)}</dd></div>
        ${summary.options.length > 0
      ? `<div class="grid gap-0.5"><dt class="text-muted">${t('confirmOptions')}</dt><dd class="m-0">${summary.options.map((option) => escapeHtml(option)).join(' · ')}</dd></div>`
      : ''}
        <div class="grid gap-0.5"><dt class="text-muted">${t('confirmDuration')}</dt><dd class="m-0">${escapeHtml(summary.durationLabel)}</dd></div>
        <div class="grid gap-0.5"><dt class="text-muted">${t('confirmDescription')}</dt><dd class="m-0">${summary.description ? escapeHtml(summary.description) : t('confirmNone')}</dd></div>
      </dl>
      <div class="flex flex-wrap items-center justify-end gap-2.5">
        <button class="cursor-pointer rounded-full border border-border bg-panel px-4 py-2.5 text-sm text-ink hover:border-primary hover:text-primary" type="button" data-confirm-back>${t('confirmBack')}</button>
        <button class="cursor-pointer rounded-full border border-primary bg-primary px-4 py-2.5 text-white" type="button" data-confirm-submit>${t('confirmSubmit')}</button>
      </div>
    </section>
  `;
}

export const MAX_OPTIONS = MAX_POLL_OPTIONS;
export const MIN_OPTIONS = MIN_POLL_OPTIONS;
export const MAX_LABEL_LENGTH = MAX_OPTION_LABEL_LENGTH;
export type { PollDuration, PollType };
