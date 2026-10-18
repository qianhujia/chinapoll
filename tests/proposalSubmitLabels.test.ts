// Submit-form label tests against the real locale file.
//
// `tests/proposalTranslations.test.ts` checks the wiring with a stub dictionary;
// this file loads `public/i18n/zh.json` itself, so the Chinese wording the form
// shows is asserted exactly as it ships.

import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { loadTranslations, setDefaultLocale } from '../src/i18n';
import {
  DESCRIPTION_MIN_ROWS,
  descriptionFieldMarkup,
  durationFieldMarkup,
  optionsFieldsetMarkup,
  templateOptionLabels
} from '../src/pages/proposal';

const zh: Record<string, string> = JSON.parse(readFileSync('public/i18n/zh.json', 'utf8'));

beforeAll(async () => {
  // Stands in for `/i18n/zh.json`, which the app fetches when the default locale
  // is Chinese.
  vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => zh }));
  setDefaultLocale('zh-CN');
  await loadTranslations('zh-CN');
});

describe('submit form labels in Chinese', () => {
  it('names the duration field by its deadline wording', () => {
    const markup = durationFieldMarkup();

    // The user-facing wording is the deadline date, not "duration".
    expect(markup).toContain('截至日期');
    expect(markup).not.toContain('时长');
    expect(markup).toContain('无截止日期');
    expect(markup).not.toContain('durationLabel');
  });

  it('shows the month and year durations as 1 个月 and 1 年', () => {
    const markup = durationFieldMarkup();

    expect(markup).toContain('<option value="1m">1 个月</option>');
    // Half a year sits between a month and a year.
    expect(markup).toContain('<option value="6m">半年</option>');
    expect(markup).toContain('<option value="1y">1 年</option>');
    expect(markup.indexOf('value="1m"')).toBeLessThan(markup.indexOf('value="6m"'));
    expect(markup.indexOf('value="6m"')).toBeLessThan(markup.indexOf('value="1y"'));
    // The day counts are gone from the wording; the stored lengths do not change.
    expect(markup).not.toContain('30 天');
    expect(markup).not.toContain('365 天');
    expect(markup).not.toContain('duration1m');
    expect(markup).not.toContain('duration1y');
  });

  it('labels the description field and starts it at two rows', () => {
    const markup = descriptionFieldMarkup();

    expect(markup).toContain('说明（可选）');
    expect(markup).not.toContain('proposalDescriptionLabel');
    expect(markup).toContain(`rows="${DESCRIPTION_MIN_ROWS}"`);
  });

  it('renders every field label in bold', () => {
    const duration = durationFieldMarkup();
    const description = descriptionFieldMarkup();

    // The label is bold and the control inside it keeps normal weight text.
    expect(duration).toContain('<label class="grid gap-2 font-bold" for="proposal-duration">');
    expect(description).toContain('<label class="grid gap-2 font-bold" for="proposal-description">');
    expect(duration).toContain('py-3 font-normal"');
    expect(description).toContain('py-3 font-normal"');
    // The options legend is bold as well.
    expect(optionsFieldsetMarkup()).toContain('<legend class="mb-2 font-bold">选项</legend>');
  });
});

describe('template option rows', () => {
  it('pre-fills the three verdict words for the Verdict card only', () => {
    expect(templateOptionLabels('verdict')).toEqual(['赞同', '中立', '反对']);
    // A single or multiple choice card has nothing to pre-fill, so the editor
    // starts from two empty rows and the verdict words are cleaned away.
    expect(templateOptionLabels('single_choice')).toEqual([]);
    expect(templateOptionLabels('multi_choice')).toEqual([]);
  });
});
