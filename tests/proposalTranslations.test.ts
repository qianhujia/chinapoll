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
  aiTitleMarkup,
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
  duration1y: '1 year',
  optionsLabel: 'Options',
  addOption: 'Add option',
  aiSuggestOptions: 'Suggest options',
  aiDiscardSuggestions: 'Discard suggestions',
  aiEnhanceTitle: 'Enhance with AI',
  aiDisabledHint: 'Enter at least 10 characters in the title first.',
  aiPrivacyNote: 'Your draft is sent to Cloudflare Workers AI.',
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

  it('translates the options fieldset and the AI block', () => {
    const options = optionsFieldsetMarkup();
    const ai = aiTitleMarkup();

    expect(options).toContain('Options');
    expect(options).toContain('Add option');
    expect(options).not.toContain('optionsLabel');
    expect(ai).toContain('Enhance with AI');
    expect(ai).not.toContain('aiEnhanceTitle');
  });
});
