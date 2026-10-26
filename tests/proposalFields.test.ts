// Frontend submit-form field tests.
//
// `durationFieldMarkup` and `descriptionFieldMarkup` are pure markup, so they are
// checked directly: both are plain form fields with their own bold label, and the
// description grows with its text instead of hiding behind a toggle. The rule that
// resizes the description is pure as well (`nextDescriptionHeight`), so the height it
// gives back for a shrinking, growing or capped text is checked directly too.

import { describe, expect, it } from 'vitest';
import {
  DESCRIPTION_MAX_ROWS,
  DESCRIPTION_MIN_ROWS,
  categoryFieldMarkup,
  categoryOptionMarkup,
  descriptionFieldMarkup,
  durationFieldMarkup,
  nextDescriptionHeight,
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

describe('nextDescriptionHeight', () => {
  // 240px is the two rows the field starts at, 1000px the 30-row cap.
  it('never makes the field shorter while it is being edited', () => {
    // Deleting a line leaves the field as tall as it was: a shorter field lifts the
    // rest of the page and the browser scrolls the caret back into view, which drags
    // the page along under the reader.
    expect(nextDescriptionHeight(120, 240, 1000, false)).toBe(240);
    expect(nextDescriptionHeight(240, 240, 1000, false)).toBe(240);
    // Text that needs more room still grows it.
    expect(nextDescriptionHeight(360, 240, 1000, false)).toBe(360);
  });

  it('holds the field at the row cap once the text is longer', () => {
    // The field scrolls itself past the cap instead of pushing the submit button down.
    expect(nextDescriptionHeight(2000, 240, 1000, false)).toBe(1000);
    expect(nextDescriptionHeight(2000, 1000, 1000, false)).toBe(1000);
  });

  it('measures from scratch when the form is cleared', () => {
    expect(nextDescriptionHeight(240, 1000, 1000, true)).toBe(240);
    expect(nextDescriptionHeight(360, 1000, 1000, true)).toBe(360);
    expect(nextDescriptionHeight(2000, 1000, 1000, true)).toBe(1000);
  });
});

describe('categoryFieldMarkup', () => {
  it('opens its own list instead of a native select, with "No category" first', () => {
    const markup = categoryFieldMarkup();

    expect(markup).toContain('data-category-toggle');
    expect(markup).toContain('aria-haspopup="listbox"');
    expect(markup).toContain('aria-controls="proposal-category-list"');
    expect(markup).toContain('role="listbox"');
    expect(markup).toContain('data-category-list');
    // A native select cannot style part of an option's text, so the field is not one.
    expect(markup).not.toContain('<select');
    // The chosen slug travels in the hidden input the form reads, and the list starts
    // closed with only the "No category" entry.
    expect(markup).toContain('type="hidden" name="category"');
    expect(markup).toContain('data-category-list hidden');
    expect(markup).toContain('categoryNone');
  });

  it('shows a topic description in a lighter muted tone after a slash', () => {
    const markup = categoryOptionMarkup('politics', 'Politics', 'Public polls about politics.');

    expect(markup).toContain('data-category-option="politics"');
    expect(markup).toContain('role="option"');
    expect(markup).toContain('aria-selected="false"');
    // The name sits in its own element so the trigger can reuse just that part.
    expect(markup).toContain('<span data-category-option-label>Politics</span>');
    // The separator and the description are both light and muted.
    expect(markup).toContain('<span class="ml-1 font-light text-muted">/ Public polls about politics.</span>');
  });

  it('leaves the slash out when a topic has no description', () => {
    const markup = categoryOptionMarkup('other', 'Other', null);

    expect(markup).toContain('<span data-category-option-label>Other</span></button>');
    expect(markup).not.toContain('font-light');
  });

  it('escapes a hostile topic name and description', () => {
    const markup = categoryOptionMarkup('x', '<b>Name</b>', '<i>Detail</i>');

    expect(markup).not.toContain('<b>');
    expect(markup).not.toContain('<i>');
    expect(markup).toContain('&lt;b&gt;');
    expect(markup).toContain('&lt;i&gt;');
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
