// Server-side SEO metadata injection for the public Worker.
//
// The SPA shell (index.html) is served for all non-API routes. This module
// extracts the base HTML from the assets binding, injects route-specific
// <head> metadata (title, description, canonical, Open Graph, Twitter, JSON-LD),
// and returns the modified document.

import type { Env } from '../index';

export interface SeoContext {
  title: string;
  description: string;
  canonical: string;
  ogType?: 'website' | 'article';
  ogImage?: string;
  twitterCard?: 'summary' | 'summary_large_image';
  jsonLd?: Record<string, unknown>;
  robots?: string;
}

export interface PublicSettingsSeo {
  site_name: string;
  site_slogan: string;
  default_locale: string;
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/'/g, '&apos;');
}

export function buildMetaTags(seo: SeoContext, settings: PublicSettingsSeo, origin: string): string {
  const title = escapeHtml(seo.title);
  const description = escapeHtml(seo.description);
  const canonical = escapeHtml(seo.canonical);
  const siteName = escapeHtml(settings.site_name);
  const ogImage = escapeHtml(seo.ogImage ? `${origin}${seo.ogImage}` : OG_IMAGE_URL);

  const tags: string[] = [
    `<meta name="description" content="${description}" />`,
    `<meta property="og:type" content="${seo.ogType ?? 'website'}" />`,
    `<meta property="og:site_name" content="${siteName}" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:image" content="${ogImage}" />`,
    `<meta property="og:url" content="${canonical}" />`,
    `<meta name="twitter:card" content="${seo.twitterCard ?? 'summary_large_image'}" />`,
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${description}" />`,
    `<meta name="twitter:image" content="${ogImage}" />`,
    `<link rel="canonical" href="${canonical}" />`,
    `<meta name="robots" content="${seo.robots ?? 'index, follow'}" />`
  ];

  if (seo.jsonLd) {
    tags.push(`<script type="application/ld+json">${JSON.stringify(seo.jsonLd)}</script>`);
  }

  return tags.join('\n    ');
}

export function injectSeoIntoHtml(html: string, metaTags: string): string {
  // Replace the closing </head> tag with our meta tags followed by </head>
  return html.replace('</head>', `${metaTags}\n  </head>`);
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

export function getPollSeoContext(
  poll: { id: number; title: string; description: string | null; status: string },
  settings: PublicSettingsSeo,
  origin: string
): SeoContext {
  const pollUrl = `${origin}/poll/${poll.id}`;
  const description = poll.description
    ? poll.description.slice(0, 160)
    : `Vote on "${poll.title}" - ${settings.site_slogan}`;

  const jsonLd = {
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
    datePublished: new Date().toISOString(),
    keywords: ['poll', 'voting', 'public opinion', 'anonymous']
  };

  return buildSeoContext(`/poll/${poll.id}`, settings, origin, {
    title: `${poll.title} - ${settings.site_name}`,
    description,
    canonical: pollUrl,
    ogType: 'article',
    ogImage: '/og-image.png',
    jsonLd
  });
}

export function getHomeSeoContext(settings: PublicSettingsSeo, origin: string): SeoContext {
  return buildSeoContext('/', settings, origin, {
    title: `${settings.site_name} - ${settings.site_slogan}`,
    description: settings.site_slogan,
    ogType: 'website'
  });
}

export function getPollsListSeoContext(settings: PublicSettingsSeo, origin: string): SeoContext {
  return buildSeoContext('/polls', settings, origin, {
    title: `All Polls - ${settings.site_name}`,
    description: `Browse all open polls on ${settings.site_name}. ${settings.site_slogan}`,
    ogType: 'website'
  });
}

export function getAboutSeoContext(settings: PublicSettingsSeo, origin: string): SeoContext {
  return buildSeoContext('/about', settings, origin, {
    title: `About - ${settings.site_name}`,
    description: `Learn about ${settings.site_name}: ${settings.site_slogan}`,
    ogType: 'website'
  });
}

export function getSubmitSeoContext(settings: PublicSettingsSeo, origin: string): SeoContext {
  return buildSeoContext('/submit', settings, origin, {
    title: `Submit a Poll - ${settings.site_name}`,
    description: `Create a new poll on ${settings.site_name}. ${settings.site_slogan}`,
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