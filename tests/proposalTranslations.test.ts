// Submit-form translation tests.
//
// The form markup comes from the loaded locale, so every label has to be looked
// up when the markup is built. A module-level string constant would capture `t()`
// on import, before the translations arrive, and render raw i18n keys instead.
// This file reproduces that order deliberately: the page modules are imported
// first (as the bundle does) and the locale is loaded afterwards.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { loadTranslations } from '../src/i18n';
import {
  categoryFieldMarkup,
  descriptionFieldMarkup,
  durationFieldMarkup,
  optionsFieldsetMarkup
} from '../src/pages/proposal';

// The subset of `public/i18n/en.json` the submit form uses.
const DICTIONARY: Record<string, string> = {
  durationLabel: 'Duration',
  durationNone: 'No end date',
  duration1d: '1 day',
  duration3d: '3 days',
  duration7d: '7 days',
  duration14d: '14 days',
  duration1m: '1 month',
  duration6m: '6 months',
  duration1y: '1 year',
  optionsLabel: 'Options',
  addOption: 'Add option',
  proposalDescriptionLabel: 'Description (optional)'
};

beforeAll(async () => {
  // Stands in for `/i18n/en.json`, which the app fetches before the first render.
  vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => DICTIONARY }));
  await loadTranslations('en');
});

describe('submit form labels', () => {
  it('translates the duration options instead of showing the i18n keys', () => {
    const markup = durationFieldMarkup();

    expect(markup).toContain('<option value="none" selected>No end date</option>');
    expect(markup).toContain('<option value="7d">7 days</option>');
    expect(markup).toContain('Duration');
    expect(markup).not.toContain('durationLabel');
    expect(markup).not.toContain('durationNone');
    expect(markup).not.toContain('duration7d');
  });

  it('translates the description field label', () => {
    const markup = descriptionFieldMarkup();

    expect(markup).toContain('Description (optional)');
    expect(markup).not.toContain('proposalDescriptionLabel');
  });

  it('translates the options fieldset and offers no AI control', () => {
    const options = optionsFieldsetMarkup();

    expect(options).toContain('Options');
    expect(options).toContain('Add option');
    expect(options).not.toContain('optionsLabel');
    // The submit form no longer carries the AI buttons, their Turnstile widgets,
    // or the suggestion list.
    expect(options).not.toContain('data-ai-options');
    expect(options).not.toContain('aiSuggestOptions');
    expect(options).not.toContain('data-ai-discard');
    expect(descriptionFieldMarkup()).not.toContain('data-ai-enhance-description');
    expect(categoryFieldMarkup()).not.toContain('data-ai-category');
    expect(categoryFieldMarkup()).not.toContain('data-category-ai-tag');
  });
});
