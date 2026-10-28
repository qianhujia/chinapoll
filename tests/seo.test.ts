import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildBreadcrumbJsonLd,
  buildMetaTags,
  buildPollListJsonLd,
  buildWebsiteJsonLd,
  getAboutSeoContext,
  getHomeSeoContext,
  getPollSeoContext,
  getSubmitSeoContext,
  getTopicSeoContext,
  injectSeoIntoHtml,
  type PublicSettingsSeo
} from '../worker/services/seo';
import { translatorFor } from '../worker/services/ssr';
import { getSeoForRoute, topicSeoData, updateSeo } from '../src/seo';
import zhDictionary from '../public/i18n/zh.json';

const settings: PublicSettingsSeo = {
  site_name: 'ChinaPoll & Co',
  site_slogan: 'Visible <opinion>',
  default_locale: 'en'
};

const ORIGIN = 'https://example.com';

describe('buildMetaTags', () => {
  it('escapes values taken from settings and the route', () => {
    const tags = buildMetaTags(getHomeSeoContext(settings, ORIGIN), settings, ORIGIN);
    expect(tags).toContain('content="ChinaPoll &amp; Co"');
    // Everything a tag carries stays escaped; the title proves it, since its text keeps
    // its angle brackets.
    expect(tags)
      .toContain('<meta property="og:title" content="ChinaPoll &amp; Co - Visible &lt;opinion&gt;" />');
    // A description is published as plain text, so anything tag-shaped in it is dropped
    // instead of escaped.
    expect(tags).toContain('<meta name="description" content="Visible" />');
    // The raw value never appears inside an HTML attribute or text node; the
    // JSON-LD block is the only place it stays verbatim (inside a script).
    expect(tags).not.toContain('content="Visible <opinion>"');
  });

  it('marks up the Open Graph locale and application name', () => {
    const tags = buildMetaTags(getHomeSeoContext(settings, ORIGIN), settings, ORIGIN);
    expect(tags).toContain('<meta property="og:locale" content="en_US" />');
    expect(tags).toContain('<meta name="application-name" content="ChinaPoll &amp; Co" />');
    expect(tags).toContain('<meta property="og:image:alt"');
  });

  it('emits one JSON-LD script per document', () => {
    const seo = { ...getHomeSeoContext(settings, ORIGIN), jsonLd: [{ '@type': 'A' }, { '@type': 'B' }] };
    const tags = buildMetaTags(seo, settings, ORIGIN);
    expect(tags.match(/application\/ld\+json/g)).toHaveLength(2);
  });

  it('keeps a closing script tag out of the JSON-LD block', () => {
    const tags = buildMetaTags(
      { ...getHomeSeoContext(settings, ORIGIN), jsonLd: { name: '</script><script>alert(1)</script>' } },
      settings,
      ORIGIN
    );
    expect(tags).not.toContain('</script><script>alert(1)');
  });

  it('inlines the admin-configured favicon when one is set', () => {
    const favicon = 'data:image/x-icon;base64,AAABAAEA';
    const tags = buildMetaTags(getHomeSeoContext(settings, ORIGIN), { ...settings, favicon }, ORIGIN);
    expect(tags).toContain(`<link rel="icon" href="${favicon}" />`);
  });

  it('omits the favicon link when none is configured', () => {
    const tags = buildMetaTags(getHomeSeoContext(settings, ORIGIN), settings, ORIGIN);
    expect(tags).not.toContain('rel="icon"');
  });

  // A description is shown as one sentence, so no tag and no line break may survive in
  // it, whatever text the route handed over.
  it('publishes the description without tags or line breaks', () => {
    const tags = buildMetaTags(
      { ...getHomeSeoContext(settings, ORIGIN), description: '<p>Two lines</p>\n<b>and more</b>' },
      settings,
      ORIGIN
    );

    expect(tags).toContain('<meta name="description" content="Two lines and more" />');
    expect(tags).toContain('<meta property="og:description" content="Two lines and more" />');
    expect(tags).toContain('<meta name="twitter:description" content="Two lines and more" />');
    expect(tags).not.toContain('<b>');
  });
});

describe('structured data', () => {
  it('adds a site search action to the website document', () => {
    const jsonLd = buildWebsiteJsonLd(settings, ORIGIN);
    expect(jsonLd['@type']).toBe('WebSite');
    expect(jsonLd.potentialAction).toMatchObject({
      '@type': 'SearchAction',
      target: { urlTemplate: `${ORIGIN}/?q={search_term_string}` }
    });
  });

  it('numbers the poll list items in order', () => {
    const jsonLd = buildPollListJsonLd(
      [{ number: 3, title: 'Third' }, { number: 7, title: 'Seventh' }],
      settings,
      ORIGIN
    );
    expect(jsonLd['@type']).toBe('ItemList');
    expect(jsonLd.numberOfItems).toBe(2);
    expect(jsonLd.itemListElement).toEqual([
      { '@type': 'ListItem', position: 1, url: `${ORIGIN}/poll/3`, name: 'Third' },
      { '@type': 'ListItem', position: 2, url: `${ORIGIN}/poll/7`, name: 'Seventh' }
    ]);
  });

  it('numbers the breadcrumb trail in order', () => {
    const jsonLd = buildBreadcrumbJsonLd([
      { name: 'Home', url: `${ORIGIN}/` },
      { name: 'Poll', url: `${ORIGIN}/poll/3` }
    ]);
    expect(jsonLd.itemListElement).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${ORIGIN}/` },
      { '@type': 'ListItem', position: 2, name: 'Poll', item: `${ORIGIN}/poll/3` }
    ]);
  });
});

describe('route contexts', () => {
  it('gives a poll page its canonical URL and a breadcrumb', () => {
    const seo = getPollSeoContext(
      { number: 42, title: 'Bike lanes', description: 'Build more lanes.', status: 'open' },
      settings,
      ORIGIN
    );
    expect(seo.canonical).toBe(`${ORIGIN}/poll/42`);
    // The poll number prefixes the document title as "#42".
    expect(seo.title).toBe(`#42 Bike lanes - ${settings.site_name}`);
    expect(seo.ogType).toBe('article');
    expect(Array.isArray(seo.jsonLd)).toBe(true);
    expect(seo.jsonLd).toHaveLength(2);
  });

  it('gives the home page the website structured data', () => {
    const seo = getHomeSeoContext(settings, ORIGIN);
    expect(seo.canonical).toBe(`${ORIGIN}/`);
    expect((seo.jsonLd as Record<string, unknown>)['@type']).toBe('WebSite');
  });

  // The poll's own text is published as one plain line, and a description that carries
  // nothing but markup leaves the site's wording to stand in for it.
  it('reads a poll description as one plain line, and falls back when it is empty', () => {
    const tagged = getPollSeoContext(
      { number: 42, title: 'Bike lanes', description: '<p>Build more lanes</p>\n<b>now</b>', status: 'open' },
      settings,
      ORIGIN
    );
    expect(tagged.description).toBe('Build more lanes now');

    const markupOnly = getPollSeoContext(
      { number: 42, title: 'Bike lanes', description: '<br />', status: 'open' },
      settings,
      ORIGIN
    );
    expect(markupOnly.description).toBe(`Vote on "Bike lanes" - ${settings.site_slogan}`);
  });

  // The topic page names a topic, never its URL slug. The caller resolves the label
  // (see `topicLabel` in shared/categories) and the head carries it in the title, the
  // Open Graph tags, and the breadcrumb.
  it('names a topic page in the language of the site', () => {
    const seo = getTopicSeoContext(
      'economy',
      '经济',
      { ...settings, site_name: '中国民意调查', default_locale: 'zh-CN' },
      ORIGIN,
      [{ number: 3, title: 'Third' }]
    );

    expect(seo.title).toBe('经济 - 中国民意调查');
    expect(seo.description).toBe('Browse polls about 经济 on 中国民意调查.');
    expect(seo.canonical).toBe(`${ORIGIN}/topic/economy`);
    expect(seo.ogType).toBe('website');
    // The breadcrumb ends at the topic, and the list travels with it.
    const [breadcrumb, list] = seo.jsonLd as Record<string, unknown>[];
    expect(breadcrumb.itemListElement).toEqual([
      { '@type': 'ListItem', position: 1, name: '中国民意调查', item: `${ORIGIN}/` },
      { '@type': 'ListItem', position: 2, name: '经济', item: `${ORIGIN}/topic/economy` }
    ]);
    expect(list.numberOfItems).toBe(1);
  });

  it('translates the about and submit titles and descriptions', () => {
    const en = translatorFor('en');
    const zh = translatorFor('zh-CN');

    // English keeps the same wording as before, now sourced from the dictionary.
    expect(getAboutSeoContext(settings, ORIGIN, en).title).toBe(`About - ${settings.site_name}`);
    expect(getSubmitSeoContext(settings, ORIGIN, en).title).toBe(`New Poll - ${settings.site_name}`);

    // The Chinese locale swaps in the translated label and description.
    const about = getAboutSeoContext(settings, ORIGIN, zh);
    expect(about.title).toBe(`${zhDictionary.seoAboutTitle} - ${settings.site_name}`);
    expect(about.description).toContain(settings.site_name);

    const submit = getSubmitSeoContext(settings, ORIGIN, zh);
    expect(submit.title).toBe(`${zhDictionary.seoSubmitTitle} - ${settings.site_name}`);
    expect(submit.description).toContain(settings.site_name);
    // The submit page stays out of the index in every locale.
    expect(submit.robots).toBe('noindex, follow');
  });
});

describe('injectSeoIntoHtml', () => {
  const shell = '<html lang="en"><head><meta charset="UTF-8" />'
    + '<meta name="description" content="placeholder" /><title>ChinaPoll</title></head>'
    + '<body><div id="app"></div></body></html>';

  it('replaces the placeholder title and drops the placeholder description', () => {
    const seo = getHomeSeoContext(settings, ORIGIN);
    const html = injectSeoIntoHtml(shell, buildMetaTags(seo, settings, ORIGIN), seo.title);

    expect(html).not.toContain('<title>ChinaPoll</title>');
    expect(html).toContain('<title>ChinaPoll &amp; Co - Visible &lt;opinion&gt;</title>');
    expect(html).not.toContain('content="placeholder"');
    expect(html.match(/name="description"/g)).toHaveLength(1);
  });
});

// The SPA names a topic page from the route table, before any topic has loaded, and
// rebuilds the head from the loaded list afterwards (see `mountHome`). Both go
// through `topicSeoData`, so a topic page never titles itself with its URL slug.
describe('client topic route metadata', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('names a suggested topic in the language of the site', () => {
    vi.stubGlobal('window', { location: { origin: ORIGIN } });

    const seo = getSeoForRoute('/topic/economy', { ...settings, default_locale: 'zh-CN' });

    expect(seo.title).toBe(`经济 - ${settings.site_name}`);
    expect(seo.description).toBe(`Browse polls about 经济 on ${settings.site_name}.`);
    expect(seo.canonical).toBe(`${ORIGIN}/topic/economy`);
  });

  it('keeps a topic the site does not suggest under its slug', () => {
    vi.stubGlobal('window', { location: { origin: ORIGIN } });

    const seo = getSeoForRoute('/topic/my-topic', settings);

    expect(seo.title).toBe(`my-topic - ${settings.site_name}`);
    expect(seo.canonical).toBe(`${ORIGIN}/topic/my-topic`);
  });

  it('builds the topic page metadata from one shared wording', () => {
    expect(topicSeoData('economy', '经济', '中国民意调查', ORIGIN)).toEqual({
      title: '经济 - 中国民意调查',
      description: 'Browse polls about 经济 on 中国民意调查.',
      canonical: `${ORIGIN}/topic/economy`,
      ogType: 'website'
    });
  });
});

// `updateSeo` writes the live document's head, so the tags it touches are answered as
// already present and every write is recorded.
describe('client head updates', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubHead() {
    const writes: Array<{ selector: string; name: string; value: string }> = [];
    vi.stubGlobal('window', { location: { origin: ORIGIN } });
    vi.stubGlobal('document', {
      title: '',
      querySelector: (selector: string) => ({
        setAttribute: (name: string, value: string) => { writes.push({ selector, name, value }); }
      }),
      querySelectorAll: () => [],
      createElement: () => ({ setAttribute: () => {} }),
      head: { appendChild: () => {} }
    });
    return writes;
  }

  it('writes the description as one plain line', () => {
    const writes = stubHead();

    updateSeo({ description: '<b>Build</b> more lanes\non Main Street' });

    const content = (selector: string) => writes.find((write) => write.selector === selector)?.value;
    expect(content('meta[name="description"]')).toBe('Build more lanes on Main Street');
    expect(content('meta[property="og:description"]')).toBe('Build more lanes on Main Street');
    expect(content('meta[name="twitter:description"]')).toBe('Build more lanes on Main Street');
  });

  it('falls back to the site wording when the description is only markup', () => {
    const writes = stubHead();

    updateSeo({ description: '<br />' });

    // The built-in settings are in force in this environment, so their slogan stands in
    // for a description that carried nothing but markup.
    expect(writes.find((write) => write.selector === 'meta[name="description"]')?.value)
      .toBe('Public opinion made visible');
  });
});
