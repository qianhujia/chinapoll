import { describe, expect, it } from 'vitest';
import {
  buildBreadcrumbJsonLd,
  buildMetaTags,
  buildPollListJsonLd,
  buildWebsiteJsonLd,
  getAboutSeoContext,
  getHomeSeoContext,
  getPollSeoContext,
  getSubmitSeoContext,
  injectSeoIntoHtml,
  type PublicSettingsSeo
} from '../worker/services/seo';
import { translatorFor } from '../worker/services/ssr';
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
    expect(tags).toContain('content="Visible &lt;opinion&gt;"');
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

