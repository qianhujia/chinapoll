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
import { chevronDownIconMarkup, escapeHtml, t } from '../ui';

// The type cards the form offers, one per stored poll type. The Verdict card is the
// verdict type: the form pre-fills its three options with Approve, Neutral, and
// Oppose, and the submitter may then edit them like any other option row.
export type TemplateType = PollType;

// i18n keys of the options the Verdict type pre-fills, in row order.
export const VERDICT_TEMPLATE_LABEL_KEYS: ReadonlyArray<string> = ['approve', 'neutral', 'oppose'];

// The option texts a poll type starts with, in row order. Only the verdict type
// pre-fills words; a single choice or multiple choice poll starts from an empty
// list, so switching away from Verdict never carries Approve / Neutral / Oppose
// into another type.
export function templateOptionLabels(template: TemplateType): string[] {
  return template === 'verdict' ? VERDICT_TEMPLATE_LABEL_KEYS.map((key) => t(key)) : [];
}

// One selectable card per poll type, with a one-line explanation.
export function pollTypeCard(value: TemplateType, labelKey: string, hintKey: string, checked: boolean): string {
  return `
    <label class="flex cursor-pointer flex-col gap-1 rounded-[14px] border border-border bg-[#f9fbff] px-3.5 py-3">
      <span class="flex items-center gap-2.5">
        <input class="accent-primary" type="radio" name="pollType" value="${value}" data-poll-type${checked ? ' checked' : ''}>
        <span class="font-bold">${t(labelKey)}</span>
      </span>
      <span class="text-xs text-muted">${t(hintKey)}</span>
    </label>
  `;
}

// A single option row: the label input plus a remove button.
export function optionRowMarkup(position: number, label = ''): string {
  return `
    <div class="flex items-center gap-2" data-option-row data-position="${position}">
      <input class="w-full rounded-[14px] border border-border bg-[#f9fbff] px-3.5 py-3" type="text" maxlength="${MAX_OPTION_LABEL_LENGTH}" value="${escapeHtml(label)}" placeholder="${t('optionPlaceholder')}" data-option-label>
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
    <legend class="mb-2 font-bold">${t('optionsLabel')}</legend>
    <div class="grid gap-2" data-option-rows></div>
    <div class="flex flex-wrap items-center gap-2.5">
      <button class="cursor-pointer rounded-full border border-border bg-panel px-3.5 py-2 text-sm text-ink disabled:cursor-not-allowed disabled:opacity-60" type="button" data-add-option>${t('addOption')}</button>
    </div>
  </fieldset>
  `;
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
    <label class="grid gap-2 font-bold" for="proposal-duration">${t('durationLabel')}
      <select class="w-full rounded-[14px] border border-border bg-[#f9fbff] px-3.5 py-3 font-normal" id="proposal-duration" name="duration">
        ${options}
      </select>
    </label>
  `;
}

// One entry in the category list: the topic name on the left and its description in
// a lighter muted tone, right aligned on the same row and without a separator in
// front of it. `description` is null for "No category" and for a topic that carries
// none, so the right side stays empty unless there is something to say. The name sits
// in its own element so the trigger can reuse just that part.
export function categoryOptionMarkup(value: string, label: string, description: string | null): string {
  const detail = description
    ? `<span class="pl-3 text-right font-light text-muted">${escapeHtml(description)}</span>`
    : '';
  return `
          <button type="button" class="flex w-full cursor-pointer items-center justify-between gap-2 rounded-[10px] px-3 py-2 text-left text-sm text-ink hover:bg-[#eef3fb]" role="option" aria-selected="false" data-category-option="${escapeHtml(value)}"><span data-category-option-label>${escapeHtml(label)}</span>${detail}</button>`;
}

// The category dropdown with "No category" first. A native `<select>` cannot style
// part of an option's text, so the field is a button that opens its own list: every
// entry shows the topic name with its description in a lighter muted tone, right
// aligned beside it. The chosen slug is kept in the hidden input the form reads, and
// the topics are appended from `GET /api/topics` after the form mounts, so the markup
// itself is static.
export function categoryFieldMarkup(): string {
  const label = escapeHtml(t('categoryLabel'));
  return `
    <div class="grid gap-2" data-category-field>
      <span class="font-bold" id="proposal-category-label">${label}</span>
      <div class="relative">
        <button type="button" class="flex w-full items-center justify-between gap-2 rounded-[14px] border border-border bg-[#f9fbff] px-3.5 py-3 text-left font-normal text-ink" id="proposal-category" data-category-toggle aria-haspopup="listbox" aria-expanded="false" aria-controls="proposal-category-list" aria-labelledby="proposal-category-label">
          <span data-category-label>${escapeHtml(t('categoryNone'))}</span>
          ${chevronDownIconMarkup('h-4 w-4 shrink-0 text-muted')}
        </button>
        <div class="absolute right-0 left-0 z-20 mt-1 max-h-72 overflow-auto rounded-[14px] border border-border bg-panel p-1 shadow-card" id="proposal-category-list" role="listbox" aria-labelledby="proposal-category-label" data-category-list hidden>${categoryOptionMarkup('', t('categoryNone'), null)}
        </div>
        <div class="fixed inset-0 z-10" data-category-backdrop hidden></div>
      </div>
      <input type="hidden" name="category" value="" data-category>
      <p class="m-0 text-sm text-muted hidden" data-category-description></p>
    </div>
  `;
}

// The rules a submission has to meet, shown on the submit page. There are four:
// the old "it can produce a clear yes/no/neutral outcome" rule was removed once the
// poll types carried that meaning themselves, so the wording that followed it moved
// up a key.
export function proposalRulesMarkup(): string {
  return `
          <ol class="list-decimal space-y-1 pl-6">
            <li>${t('proposalRuleOne')}</li>
            <li>${t('proposalRuleTwo')}</li>
            <li>${t('proposalRuleThree')}</li>
            <li>${t('proposalRuleFour')}</li>
          </ol>`;
}

// The optional description: a plain field with its own label, no collapsible
// wrapper. It starts at two rows and grows with the text up to 30 rows, after
// which it scrolls instead of growing further (see `bindProposalForm`).
export function descriptionFieldMarkup(): string {
  return `
    <label class="grid gap-2 font-bold" for="proposal-description">${t('proposalDescriptionLabel')}
      <textarea class="w-full resize-none overflow-hidden rounded-[14px] border border-border bg-white px-3.5 py-3 font-normal" id="proposal-description" name="description" rows="${DESCRIPTION_MIN_ROWS}" maxlength="2000"></textarea>
    </label>
  `;
}

// The height the description field is resized to. `content` is the height its text
// needs and `current` is the height it renders at now, both as border-box heights
// that include the padding and the borders. While the visitor is editing, the field
// only ever grows: a shorter field lifts everything below it, which makes the browser
// scroll the caret back into view and drag the page along under the reader.
// `remeasure` measures the field from scratch instead and is used when a submission
// clears it, so the two rows it starts from come back. `maxHeight` is the 30-row cap:
// past it the field scrolls instead of growing further.
export function nextDescriptionHeight(
  content: number,
  current: number,
  maxHeight: number,
  remeasure: boolean
): number {
  if (remeasure) return Math.min(content, maxHeight);
  return Math.min(Math.max(content, current), maxHeight);
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
// Rows of the description field: it starts at two and grows to at most 30, after
// which the field scrolls.
export const DESCRIPTION_MIN_ROWS = 2;
export const DESCRIPTION_MAX_ROWS = 30;
export type { PollDuration, PollType };
