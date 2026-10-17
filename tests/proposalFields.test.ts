// Frontend submit-form field tests.
//
// `durationFieldMarkup` and `descriptionFieldMarkup` are pure markup, so they are
// checked directly: the duration is a plain field of the form, and the
// description is the only collapsible part, collapsed by default.

import { describe, expect, it } from 'vitest';
import { descriptionFieldMarkup, durationFieldMarkup } from '../src/pages/proposal';

// Translations are not loaded in this environment, so `t()` falls back to the
// i18n key and the assertions below read those keys.
describe('durationFieldMarkup', () => {
  it('renders the duration as a plain field instead of a collapsible panel', () => {
    const markup = durationFieldMarkup();

    expect(markup).toContain('for="proposal-duration"');
    expect(markup).toContain('id="proposal-duration"');
    expect(markup).toContain('name="duration"');
    // The options come from the shared duration list, "No end date" preselected.
    expect(markup).toContain('<option value="none" selected>');
    expect(markup).toContain('<option value="7d">');
    // Nothing about the duration sits behind a toggle any more.
    expect(markup).not.toContain('<details');
    expect(markup).not.toContain('summary');
    expect(markup).not.toContain('advancedOptions');
  });
});

describe('descriptionFieldMarkup', () => {
  it('renders the description inside a panel that starts collapsed', () => {
    const markup = descriptionFieldMarkup();

    expect(markup).toContain('<details');
    expect(markup).toContain('data-description-details');
    expect(markup).toContain('<summary');
    expect(markup).toContain('proposalDescriptionToggle');
    // Collapsed by default: the details element carries no `open` attribute.
    expect(markup).not.toMatch(/<details[^>]*\sopen/);
    // The old "Advanced options" wrapper is gone.
    expect(markup).not.toContain('advancedOptions');
  });

  it('keeps the field the form binding expects', () => {
    const markup = descriptionFieldMarkup();

    expect(markup).toContain('id="proposal-description"');
    expect(markup).toContain('name="description"');
    expect(markup).toContain('maxlength="2000"');
    // The summary names the field, and the label itself stays available to
    // assistive technology once the textarea is revealed.
    expect(markup).toContain('sr-only');
    expect(markup).toContain('proposalDescriptionLabel');
  });
});
