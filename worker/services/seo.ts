// Server-side SEO metadata injection for the public Worker.
//
// The document shell (index.html) is served for all non-API routes. This module
// builds route-specific <head> metadata (title, description, canonical, Open
// Graph, Twitter, robots, JSON-LD) and the public Worker injects it into the
// document (see withSeoMetadata in ../index).

import { escapeHtml, serializeJsonLd } from './html';
import type { Translate } from './ssr';

export interface SeoContext {
  title: string;
  description: string;
  canonical: string;
  ogType?: 'website' | 'article';
  ogImage?: string;
  twitterCard?: 'summary' | 'summary_large_image';
  /** One or more JSON-LD documents, each emitted in its own script block. */
  jsonLd?: Record<string, unknown> | Record<string, unknown>[];
  robots?: string;
}

export interface PublicSettingsSeo {
  site_name: string;
  site_slogan: string;
  default_locale: string;
  /** Optional base64 data URI of the configured favicon. */
  favicon?: string;
}

const DEFAULT_SEO: SeoContext = {
  title: 'ChinaPoll',
  description: 'ChinaPoll - a privacy-first public opinion polling platform.',
  canonical: 'https://chinapoll.org/',
  ogType: 'website',
  ogImage: '/og-image.png',
  twitterCard: 'summary_large_image',
  robots: 'index, follow'
};

const OG_IMAGE_URL = 'https://chinapoll.org/og-image.png';

// Maps the site's default locale to an Open Graph locale tag.
function ogLocale(defaultLocale: string): string {
  const value = (defaultLocale ?? 'en').toLowerCase();
  if (value.startsWith('zh-tw') || value.startsWith('zh_hant')) return 'zh_TW';
  if (value.startsWith('zh')) return 'zh_CN';
  return 'en_US';
}

function toJsonLdList(jsonLd: SeoContext['jsonLd']): Record<string, unknown>[] {
  if (!jsonLd) return [];
  return Array.isArray(jsonLd) ? jsonLd : [jsonLd];
}

export function buildMetaTags(seo: SeoContext, settings: PublicSettingsSeo, origin: string): string {
  const title = escapeHtml(seo.title);
  const description = escapeHtml(seo.description);
  const canonical = escapeHtml(seo.canonical);
  const siteName = escapeHtml(settings.site_name);
  const ogImage = escapeHtml(seo.ogImage ? `${origin}${seo.ogImage}` : OG_IMAGE_URL);

  const tags: string[] = [
    `<meta name="description" content="${description}" />`,
    `<meta name="application-name" content="${siteName}" />`,
    `<meta property="og:type" content="${seo.ogType ?? 'website'}" />`,
    `<meta property="og:site_name" content="${siteName}" />`,
    `<meta property="og:locale" content="${ogLocale(settings.default_locale)}" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:image" content="${ogImage}" />`,
    `<meta property="og:image:alt" content="${title}" />`,
    `<meta property="og:url" content="${canonical}" />`,
    `<meta name="twitter:card" content="${seo.twitterCard ?? 'summary_large_image'}" />`,
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${description}" />`,
    `<meta name="twitter:image" content="${ogImage}" />`,
    `<link rel="canonical" href="${canonical}" />`,
    `<meta name="robots" content="${seo.robots ?? 'index, follow'}" />`
  ];

  // The favicon is admin-controlled and stored as a data URI, so the document
  // ships it inline. Without one the browser requests the site default.
  if (settings.favicon) {
    tags.push(`<link rel="icon" href="${escapeHtml(settings.favicon)}" />`);
  }

  for (const document of toJsonLdList(seo.jsonLd)) {
    tags.push(`<script type="application/ld+json">${serializeJsonLd(document)}</script>`);
  }

  return tags.join('\n    ');
}


export function injectSeoIntoHtml(html: string, metaTags: string, title: string): string {
  // The static shell ships a placeholder <title> and <meta name="description">.
  // Replace the title and drop the placeholder description so the document ends
  // up with exactly one of each instead of two conflicting tags.
  const withTitle = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`);
  const withoutPlaceholder = withTitle.replace(/[ \t]*<meta name="description"[^>]*>\s*/i, '');
  return withoutPlaceholder.replace('</head>', `${metaTags}\n  </head>`);
}

export function buildSeoContext(
  route: string,
  settings: PublicSettingsSeo,
  origin: string,
  extra?: Partial<SeoContext>
): SeoContext {
  const base: SeoContext = {
    title: settings.site_name,
    description: settings.site_slogan,
    canonical: origin + route,
    ogType: 'website',
    ogImage: '/og-image.png',
    twitterCard: 'summary_large_image',
    robots: 'index, follow',
    ...extra
  };

  // Ensure canonical has no trailing slash except root
  if (base.canonical.length > origin.length + 1 && base.canonical.endsWith('/')) {
    base.canonical = base.canonical.slice(0, -1);
  }

  return base;
}

// The site-level structured data: the WebSite plus the search action that lets a
// search engine offer the on-site poll search straight from its results page.
export function buildWebsiteJsonLd(settings: PublicSettingsSeo, origin: string): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: settings.site_name,
    description: settings.site_slogan,
    url: `${origin}/`,
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: `${origin}/?q={search_term_string}`
      },
      'query-input': 'required name=search_term_string'
    }
  };
}

// The ordered list of polls shown on a listing page, so a crawler sees the same
// items and their order the visitor sees.
export function buildPollListJsonLd(
  polls: ReadonlyArray<{ number: number; title: string }>,
  settings: PublicSettingsSeo,
  origin: string
): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: `Polls on ${settings.site_name}`,
    numberOfItems: polls.length,
    itemListElement: polls.map((poll, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      // The public number, so the structured data points at the same URL a
      // visitor follows instead of at the internal primary key.
      url: `${origin}/poll/${poll.number}`,
      name: poll.title
    }))
  };
}

// The trail from the home page to the current page.
export function buildBreadcrumbJsonLd(
  trail: ReadonlyArray<{ name: string; url: string }>
): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((entry, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: entry.name,
      item: entry.url
    }))
  };
}

export function getPollSeoContext(
  poll: { number: number; title: string; description: string | null; status: string },
  settings: PublicSettingsSeo,
  origin: string
): SeoContext {
  // The public URL and the title use the poll's public number, never the primary
  // key, so the address a visitor sees is the identifier the site publishes.
  const pollUrl = `${origin}/poll/${poll.number}`;
  const description = poll.description
    ? poll.description.slice(0, 160)
    : `Vote on "${poll.title}" - ${settings.site_slogan}`;

  return buildSeoContext(`/poll/${poll.number}`, settings, origin, {
    title: `#${poll.number} ${poll.title} - ${settings.site_name}`,
    description,
    canonical: pollUrl,
    ogType: 'article',
    ogImage: '/og-image.png',
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'Dataset',
        name: poll.title,
        description: poll.description ?? `A poll on ${settings.site_name}.`,
        url: pollUrl,
        publisher: {
          '@type': 'Organization',
          name: settings.site_name,
          url: origin
        },
        keywords: ['poll', 'voting', 'public opinion', 'anonymous']
      },
      buildBreadcrumbJsonLd([
        { name: settings.site_name, url: `${origin}/` },
        { name: poll.title, url: pollUrl }
      ])
    ]
  });
}

export function getHomeSeoContext(settings: PublicSettingsSeo, origin: string): SeoContext {
  return buildSeoContext('/', settings, origin, {
    title: `${settings.site_name} - ${settings.site_slogan}`,
    description: settings.site_slogan,
    ogType: 'website',
    jsonLd: buildWebsiteJsonLd(settings, origin)
  });
}

export function getPollsListSeoContext(settings: PublicSettingsSeo, origin: string): SeoContext {
  return buildSeoContext('/polls', settings, origin, {
    title: `All Polls - ${settings.site_name}`,
    description: `Browse all open polls on ${settings.site_name}. ${settings.site_slogan}`,
    ogType: 'website',
    jsonLd: buildWebsiteJsonLd(settings, origin)
  });
}

export function getAboutSeoContext(settings: PublicSettingsSeo, origin: string, t: Translate): SeoContext {
  return buildSeoContext('/about', settings, origin, {
    title: `${t('seoAboutTitle')} - ${settings.site_name}`,
    description: t('seoAboutDescription')
      .replace('{name}', settings.site_name)
      .replace('{slogan}', settings.site_slogan),
    ogType: 'website'
  });
}

export function getSubmitSeoContext(settings: PublicSettingsSeo, origin: string, t: Translate): SeoContext {
  return buildSeoContext('/submit', settings, origin, {
    title: `${t('seoSubmitTitle')} - ${settings.site_name}`,
    description: t('seoSubmitDescription')
      .replace('{name}', settings.site_name)
      .replace('{slogan}', settings.site_slogan),
    ogType: 'website',
    robots: 'noindex, follow'
  });
}

export function getAuthSeoContext(route: string, settings: PublicSettingsSeo, origin: string): SeoContext {
  const titles: Record<string, string> = {
    '/login': 'Sign In',
    '/register': 'Sign Up',
    '/reset': 'Reset Password'
  };
  const title = titles[route] ?? 'Account';
  return buildSeoContext(route, settings, origin, {
    title: `${title} - ${settings.site_name}`,
    description: `${title} to access ${settings.site_name} features.`,
    ogType: 'website',
    robots: 'noindex, nofollow'
  });
}

export function getAccountSeoContext(settings: PublicSettingsSeo, origin: string): SeoContext {
  return buildSeoContext('/account', settings, origin, {
    title: `My Account - ${settings.site_name}`,
    description: `Manage your account and polls on ${settings.site_name}.`,
    ogType: 'website',
    robots: 'noindex, nofollow'
  });
}

export function getNotFoundSeoContext(settings: PublicSettingsSeo, origin: string): SeoContext {
  return buildSeoContext('/404', settings, origin, {
    title: `Page Not Found - ${settings.site_name}`,
    description: `The page you're looking for doesn't exist on ${settings.site_name}.`,
    ogType: 'website',
    robots: 'noindex, nofollow'
  });
}