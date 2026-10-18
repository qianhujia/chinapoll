// Frontend submit-form field tests.
//
// `durationFieldMarkup` and `descriptionFieldMarkup` are pure markup, so they are
// checked directly: both are plain form fields with their own bold label, and the
// description grows with its text instead of hiding behind a toggle.

import { describe, expect, it } from 'vitest';
import {
  DESCRIPTION_MAX_ROWS,
  DESCRIPTION_MIN_ROWS,
  descriptionFieldMarkup,
  durationFieldMarkup,
  optionsFieldsetMarkup,
  pollTypeCard,
  proposalRulesMarkup
} from '../src/pages/proposal';

// Translations are not loaded in this environment, so `t()` falls back to the
// i18n key and the assertions below read those keys.

// The label a field is rendered under has to be bold, so every label, legend and
// card title on the form carries `font-bold`.
function boldLabelCount(markup: string): number {
  return markup.match(/class="[^"]*font-bold[^"]*"/g)?.length ?? 0;
}

describe('durationFieldMarkup', () => {
  it('renders the duration as a plain field with a bold label', () => {
    const markup = durationFieldMarkup();

    expect(markup).toContain('for="proposal-duration"');
    expect(markup).toContain('id="proposal-duration"');
    expect(markup).toContain('name="duration"');
    // The options come from the shared duration list, "No end date" preselected.
    expect(markup).toContain('<option value="none" selected>');
    expect(markup).toContain('<option value="7d">');
    // The label is bold, and the control inside it is not.
    expect(markup).toContain('class="grid gap-2 font-bold"');
    expect(markup).toContain('py-3 font-normal"');
    // Nothing sits behind a toggle any more.
    expect(markup).not.toContain('<details');
    expect(markup).not.toContain('summary');
    expect(markup).not.toContain('advancedOptions');
  });
});

describe('descriptionFieldMarkup', () => {
  it('renders the description as a plain field with its own bold label', () => {
    const markup = descriptionFieldMarkup();

    // No collapsible wrapper: the field is visible from the start.
    expect(markup).not.toContain('<details');
    expect(markup).not.toContain('<summary');
    expect(markup).not.toContain('data-description-details');
    expect(markup).not.toContain('advancedOptions');
    // The label is the field's own, visible to everyone rather than only to
    // assistive technology.
    expect(markup).toContain('proposalDescriptionLabel');
    expect(markup).not.toContain('proposalDescriptionToggle');
    expect(markup).not.toContain('sr-only');
    expect(markup).toContain('class="grid gap-2 font-bold"');
    // The textarea inside the bold label keeps normal weight text.
    expect(markup).toContain('py-3 font-normal"');
  });

  it('starts at two rows and lets the binding grow it up to the row cap', () => {
    const markup = descriptionFieldMarkup();

    expect(markup).toContain(`rows="${DESCRIPTION_MIN_ROWS}"`);
    expect(DESCRIPTION_MIN_ROWS).toBe(2);
    expect(DESCRIPTION_MAX_ROWS).toBe(30);
    // The height is JavaScript-managed, so the browser resize handle is off and a
    // short description never shows a scrollbar.
    expect(markup).toContain('resize-none');
    expect(markup).toContain('overflow-hidden');
    expect(markup).not.toContain('min-h-[140px]');
  });

  it('keeps the field the form binding expects', () => {
    const markup = descriptionFieldMarkup();

    expect(markup).toContain('id="proposal-description"');
    expect(markup).toContain('name="description"');
    expect(markup).toContain('maxlength="2000"');
    expect(markup).toContain('for="proposal-description"');
  });
});

describe('proposalRulesMarkup', () => {
  it('lists the four rules and no yes/no/neutral outcome rule', () => {
    const markup = proposalRulesMarkup();

    expect(markup.match(/<li>/g)).toHaveLength(4);
    expect(markup).toContain('proposalRuleOne');
    expect(markup).toContain('proposalRuleTwo');
    expect(markup).toContain('proposalRuleThree');
    expect(markup).toContain('proposalRuleFour');
    // The removed rule and its key are gone.
    expect(markup).not.toContain('proposalRuleFive');
  });
});

describe('bold form labels', () => {
  it('renders the options legend, the duration label and the type cards in bold', () => {
    expect(optionsFieldsetMarkup()).toContain('<legend class="mb-2 font-bold">');
    expect(durationFieldMarkup()).toContain('font-bold');
    expect(boldLabelCount(pollTypeCard('verdict', 'pollTypeVerdict', 'pollTypeVerdictHint', true))).toBe(1);
    expect(boldLabelCount(optionsFieldsetMarkup())).toBe(1);
  });
});
