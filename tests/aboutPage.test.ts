// About page tests.
//
// The page is assembled from the shared ABOUT_SECTIONS list, so a key that is
// missing from a dictionary (or from the renderer) would leave a raw i18n key on
// the page. Both are checked here for the client page; tests/ssr.test.ts checks the
// server-rendered copy.
//
// Translations are loaded after the page module is imported, exactly as the bundle
// does it, so a module-level constant captured too early would be caught here.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ABOUT_SECTIONS } from '../shared/about';
import { loadTranslations } from '../src/i18n';
import { mountAboutPage } from '../src/pages/content';
import en from '../public/i18n/en.json';
import zh from '../public/i18n/zh.json';
import zhTW from '../public/i18n/zh-TW.json';

const ENGLISH: Record<string, string> = en;

const DICTIONARIES: ReadonlyArray<[string, Record<string, string>]> = [
  ['en', en],
  ['zh-CN', zh],
  ['zh-TW', zhTW]
];

// Every key the About page reads, in the order the page shows them.
const ABOUT_KEYS: readonly string[] = [
  'aboutTitle',
  'aboutBody',
  'aboutPointOne',
  'aboutPointTwo',
  'aboutPointThree',
  ...ABOUT_SECTIONS.flatMap((section) => [section.title, ...section.points]),
  'aiPrivacyNote'
];

beforeAll(async () => {
  // Stands in for `/i18n/en.json`, which the app fetches before the first render.
  vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => en }));
  // The page header reads the query string for the search box, which the Node test
  // environment has no global for.
  vi.stubGlobal('window', { location: { search: '' } });
  await loadTranslations('en');
});

describe('about page copy', () => {
  it('translates every about key in all three locales', () => {
    for (const [locale, dictionary] of DICTIONARIES) {
      for (const key of ABOUT_KEYS) {
        expect(dictionary[key], `${locale} is missing ${key}`).toBeTruthy();
      }
    }
  });

  it('renders one section per entry, with translated headings and bullets', () => {
    const app = { innerHTML: '' } as unknown as HTMLElement;
    mountAboutPage(app, () => {});
    const markup = app.innerHTML;

    expect(markup).toContain(ENGLISH.aboutTitle);
    for (const section of ABOUT_SECTIONS) {
      expect(markup).toContain(`<h2 class="mt-0 mb-3 text-xl font-bold">${ENGLISH[section.title]}</h2>`);
      for (const key of section.points) {
        expect(markup).toContain(`<li>${ENGLISH[key]}</li>`);
      }
      // Nothing was left as its i18n key.
      expect(markup).not.toContain(`>${section.title}<`);
    }
  });
});