import { describe, expect, it } from 'vitest';
import { PollMode } from '../worker/enums';
import {
  applyHtmlLang,
  injectAppBody,
  normalizeLocale,
  renderAboutBody,
  renderHomeBody,
  renderPollBody,
  serverTranslate,
  translatorFor,
  type SsrPollCard,
  type SsrPollDetail,
  type SsrSettings
} from '../worker/services/ssr';
import { escapeHtml, serializeJsonLd } from '../worker/services/html';
import { ABOUT_SECTIONS } from '../shared/about';
import zhDictionary from '../public/i18n/zh.json';

const settings: SsrSettings = {
  site_name: 'ChinaPoll',
  site_slogan: 'Public opinion made visible',
  default_locale: 'en',
  hero_title: 'Continuous polls',
  hero_subtitle: 'Sign in to submit a poll.',
  data_repository_url: 'https://example.com/data',
  polls_per_page: 15
};

const poll: SsrPollCard = {
  // The primary key and the public number differ on purpose: the list has to link
  // the number, not the key.
  id: 12,
  number: 34,
  title: 'Should the city build more bike lanes?',
  mode: PollMode.Evergreen,
  pollType: 2,
  topic: { slug: 'politics', name: 'Politics' }
};

describe('server-side escaping', () => {
  it('escapes markup and quotes', () => {
    expect(escapeHtml('<a href="x">&\'</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  });

  it('neutralises a closing script tag in JSON-LD', () => {
    expect(serializeJsonLd({ name: '</script><script>alert(1)</script>' }))
      .not.toContain('</script>');
  });
});

describe('document shell helpers', () => {
  it('replaces the empty SPA mount point with the rendered body', () => {
    const shell = '<html><body><div id="app"></div><script></script></body></html>';
    expect(injectAppBody(shell, '<p>hello</p>')).toContain('<div id="app"><p>hello</p></div>');
  });

  it('leaves a shell without the mount point unchanged', () => {
    const shell = '<html><body><div id="root"></div></body></html>';
    expect(injectAppBody(shell, '<p>hello</p>')).toBe(shell);
  });

  it('sets the document language from the default locale', () => {
    expect(applyHtmlLang('<html lang="en">', 'zh-CN')).toContain('<html lang="zh-CN"');
    expect(applyHtmlLang('<html lang="en">', 'zh-TW')).toContain('<html lang="zh-TW"');
    expect(applyHtmlLang('<html lang="en">', 'fr')).toContain('<html lang="en"');
  });
});

describe('server-side poll list', () => {
  it('renders crawlable poll links, topics, and navigation', () => {
    const html = renderHomeBody({
      settings,
      topics: [{ slug: 'politics', name: 'Politics', count: 4 }],
      topicTotal: 9,
      polls: [poll],
      page: 1,
      totalPages: 2,
      query: '',
      activeTopic: '',
      totalPolls: 12,
      totalVotes: 340,
      showHero: true
    });

    expect(html).toContain('href="/poll/34" data-route="/poll/34"');
    expect(html).toContain('Should the city build more bike lanes?');
    // The row shows the public number and never links the primary key.
    expect(html).toContain('>#34</span>');
    expect(html).not.toContain('href="/poll/12"');
    expect(html).toContain('href="/topic/politics"');
    expect(html).toContain('href="/about"');
    expect(html).toContain('page=2');
    // The hero statistics are part of the first paint instead of being fetched
    // by the SPA after load.
    expect(html).toContain('>12</dd>');
    expect(html).toContain('data-total-votes>340<');
    // The call to action is the "New Poll" link with its plus icon.
    expect(html).toContain(serverTranslate('ctaSubmitPolls'));
    expect(html).toContain('<path d="M5 12h14" />');
  });

  it('shows the empty message when no poll matches', () => {
    const html = renderHomeBody({
      settings,
      topics: [],
      topicTotal: 0,
      polls: [],
      page: 1,
      totalPages: 1,
      query: '',
      activeTopic: '',
      totalPolls: 0,
      totalVotes: 0,
      showHero: true
    });

    expect(html).toContain(serverTranslate('noPolls'));
  });

  it('escapes a hostile poll title', () => {
    const html = renderHomeBody({
      settings,
      topics: [],
      topicTotal: 0,
      polls: [{ ...poll, title: '<img src=x onerror=alert(1)>' }],
      page: 1,
      totalPages: 1,
      query: '',
      activeTopic: '',
      totalPolls: 0,
      totalVotes: 0,
      showHero: false
    });

    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });
});

describe('server-side poll page', () => {
  const detail: SsrPollDetail = {
    ...poll,
    description: 'A short summary.',
    status: 1,
    options: [{ label: 'Yes' }, { label: 'No' }],
    prev: null,
    next: null
  };

  it('renders the title, description, and option labels', () => {
    const html = renderPollBody(detail, settings);

    // The detail page heading is prefixed with the poll number as "#34".
    expect(html).toContain(`#${detail.number} Should the city build more bike lanes?`);
    expect(html).toContain('Should the city build more bike lanes?');
    expect(html).toContain('A short summary.');
    expect(html).toContain('Yes');
    expect(html).toContain('No');
    // A poll with no neighbors renders no navigation block at all.
    expect(html).not.toContain('Poll navigation');
  });

  it('links the previous and next poll with their numbers and titles', () => {
    const html = renderPollBody({
      ...detail,
      prev: { id: 10, number: 4, title: 'Older poll' },
      next: { id: 14, number: 9, title: 'Newer poll' }
    }, settings);

    expect(html).toContain('Poll navigation');
    expect(html).toContain('Previous poll');
    expect(html).toContain('Next poll');
    // Each link carries the public number and title and points at that route, not
    // at the primary key the row happens to have.
    expect(html).toContain('href="/poll/4"');
    expect(html).toContain('#4 Older poll');
    expect(html).toContain('href="/poll/9"');
    expect(html).toContain('#9 Newer poll');
    expect(html).not.toContain('href="/poll/10"');
    expect(html).not.toContain('href="/poll/14"');
  });

  it('escapes a neighbor title', () => {
    const html = renderPollBody({
      ...detail,
      next: { id: 14, number: 14, title: '<script>alert(1)</script>' }
    }, settings);

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('server-side header', () => {
  it('renders the wordmark when no logo is configured', () => {
    const html = renderAboutBody(settings);
    expect(html).toContain('text-3xl font-extrabold');
    expect(html).not.toContain('<img class="h-9 w-auto"');
  });

  it('renders the configured logo instead of the wordmark', () => {
    // The public settings resolve an upload to the branding endpoint and keep a
    // pasted URL as it is, so the header only ever sees a URL.
    const html = renderAboutBody({ ...settings, logo: '/image/logo.png?v=1700000000' });
    expect(html).toContain('<img class="h-9 w-auto" src="/image/logo.png?v=1700000000" alt="ChinaPoll">');
    expect(html).not.toContain('text-3xl font-extrabold');
  });
});

describe('server-side about page', () => {
  it('renders the about copy and every detail section', () => {
    const html = renderAboutBody(settings);
    expect(html).toContain(serverTranslate('aboutTitle'));
    expect(html).toContain(serverTranslate('aboutPointThree'));
    // The sections come from the shared ABOUT_SECTIONS list, so the server-rendered
    // page explains how the site works exactly like the client-rendered one.
    for (const section of ABOUT_SECTIONS) {
      // The server escapes the copy, so an apostrophe arrives as an entity.
      expect(html).toContain(escapeHtml(serverTranslate(section.title)));
      for (const key of section.points) {
        expect(html).toContain(escapeHtml(serverTranslate(key)));
      }
    }
  });
});

describe('server translator', () => {
  it('uses the SPA dictionary and falls back to the key', () => {
    expect(serverTranslate('vote')).toBe('Vote');
    expect(serverTranslate('a-key-that-does-not-exist')).toBe('a-key-that-does-not-exist');
  });
});

describe('locale-aware translator', () => {
  it('normalizes the stored locale spellings', () => {
    expect(normalizeLocale('zh-CN')).toBe('zh-CN');
    expect(normalizeLocale('zh')).toBe('zh-CN');
    expect(normalizeLocale('cn')).toBe('zh-CN');
    expect(normalizeLocale('zh-TW')).toBe('zh-TW');
    expect(normalizeLocale('zh-hant')).toBe('zh-TW');
    expect(normalizeLocale('fr')).toBe('en');
    expect(normalizeLocale(undefined)).toBe('en');
  });

  it('renders the site copy in the configured locale', () => {
    const t = translatorFor('zh-CN');

    // The server-rendered shell must not fall back to English when the site is
    // configured in another language.
    expect(t('noPolls')).toBe(zhDictionary.noPolls);
    expect(t('dataLink')).toBe(zhDictionary.dataLink);
    expect(t('noPolls')).not.toBe(serverTranslate('noPolls'));
  });

  it('falls back to English and then to the key', () => {
    expect(translatorFor('fr')('vote')).toBe('Vote');
    expect(translatorFor('zh-CN')('a-key-that-does-not-exist')).toBe('a-key-that-does-not-exist');
  });

  it('renders the home body in the configured locale', () => {
    const html = renderHomeBody({
      settings: { ...settings, default_locale: 'zh-CN' },
      topics: [],
      topicTotal: 0,
      polls: [],
      page: 1,
      totalPages: 1,
      query: '',
      activeTopic: '',
      totalPolls: 0,
      totalVotes: 0,
      showHero: true
    }, translatorFor('zh-CN'));

    expect(html).toContain(zhDictionary.noPolls);
    expect(html).not.toContain(serverTranslate('noPolls'));
    // The footer credit is translated too, not hardcoded English.
    expect(html).toContain(zhDictionary.poweredBy.split('{name}')[0]);
    expect(html).toContain(zhDictionary.poweredBy.split('{name}')[1]);
    expect(html).not.toContain('Powered by');
    // The hero call to action and its statistics labels follow the locale.
    expect(html).toContain(zhDictionary.ctaSubmitPolls);
    expect(html).toContain(zhDictionary.totalVotesCount);
    expect(html).not.toContain(serverTranslate('ctaSubmitPolls'));
  });
});
