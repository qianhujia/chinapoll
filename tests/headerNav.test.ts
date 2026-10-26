// Frontend header tests.
//
// `renderHeader` is pure markup (the search box reads the query string from
// window, which is stubbed here), so it is checked directly: the inline navigation
// is for a wide screen only, and on a narrow screen it collapses into one menu
// button at the top right whose panel repeats the same items.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { loadTranslations } from '../src/i18n';
import { renderHeader } from '../src/ui';
import en from '../public/i18n/en.json';

beforeAll(async () => {
  // Stands in for the browser globals the header reads.
  vi.stubGlobal('window', { location: { search: '' } });
  vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => en }));
  await loadTranslations('en');
});

describe('header', () => {
  it('keeps the inline navigation and the account actions for a wide screen', () => {
    const markup = renderHeader('/');

    // Both are hidden below 700px, where the menu replaces them.
    expect(markup).toContain('flex flex-wrap items-center gap-[18px] max-[700px]:hidden');
    expect(markup).toContain('flex flex-wrap items-center gap-2 max-[700px]:hidden');
    // The brand stays visible on every screen.
    expect(markup).toContain('aria-label="ChinaPoll"');
  });

  it('adds a menu button and its panel for a narrow screen', () => {
    const markup = renderHeader('/about');

    expect(markup).toContain('data-menu-toggle');
    expect(markup).toContain('aria-controls="header-menu"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain(`aria-label="${en.menuLabel}"`);
    // The button belongs to the narrow screen only.
    expect(markup).toContain('max-[700px]:flex');
    // The panel starts closed and holds the same links, in their own list.
    expect(markup).toContain('id="header-menu"');
    expect(markup).toContain('data-menu-panel');
    expect(markup).toContain('hidden basis-full flex-col');
    // The active page is marked in both copies of the navigation.
    expect(markup.match(/font-bold text-primary/g)).toHaveLength(2);
  });
});
