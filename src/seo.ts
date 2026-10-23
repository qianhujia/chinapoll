// Client-side SEO management for the SPA.
//
// This module provides functions to update document.title and meta tags
// when navigating between routes without a full page reload. The server
// renders the initial metadata and body, and this keeps the metadata in sync
// during client-side navigation.

import { getPublicSettings } from './config';
import { t } from './ui';

export interface SeoData {
  title: string;
  description: string;
  canonical: string;
  ogType?: 'website' | 'article';
  ogImage?: string;
  twitterCard?: 'summary' | 'summary_large_image';
  robots?: string;
  jsonLd?: Record<string, unknown>;
}

const DEFAULT_SEO: SeoData = {
  title: 'ChinaPoll',
  description: 'ChinaPoll - a privacy-first public opinion polling platform.',
  canonical: 'https://chinapoll.org/',
  ogType: 'website',
  ogImage: '/og-image.png',
  twitterCard: 'summary_large_image',
  robots: 'index, follow'
};

let currentSeo: SeoData = { ...DEFAULT_SEO };

// Maps the site's default locale to an Open Graph locale tag.
function ogLocale(defaultLocale: string): string {
  const value = (defaultLocale ?? 'en').toLowerCase();
  if (value.startsWith('zh-tw') || value.startsWith('zh_hant')) return 'zh_TW';
  if (value.startsWith('zh')) return 'zh_CN';
  return 'en_US';
}

function setMetaTag(name: string, content: string, isProperty = false): void {
  const attr = isProperty ? 'property' : 'name';
  let tag = document.querySelector<HTMLMetaElement>(`meta[${attr}="${name}"]`);
  if (!tag) {
    tag = document.createElement('meta');
    tag.setAttribute(attr, name);
    document.head.appendChild(tag);
  }
  tag.setAttribute('content', content);
}

function setLinkTag(rel: string, href: string): void {
  let tag = document.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!tag) {
    tag = document.createElement('link');
    tag.setAttribute('rel', rel);
    document.head.appendChild(tag);
  }
  tag.setAttribute('href', href);
}

function setJsonLd(jsonLd: Record<string, unknown> | undefined): void {
  // Remove existing JSON-LD scripts
  document.querySelectorAll('script[type="application/ld+json"]').forEach(el => el.remove());
  if (!jsonLd) return;
  const script = document.createElement('script');
  script.type = 'application/ld+json';
  script.textContent = JSON.stringify(jsonLd);
  document.head.appendChild(script);
}

export function updateSeo(seo: Partial<SeoData>): void {
  // The DOM escapes attribute and text values on write, so raw values are set
  // here; pre-escaping them would double-encode an ampersand or quote.
  const { site_name: siteName, default_locale: defaultLocale } = getPublicSettings();
  currentSeo = { ...currentSeo, ...seo };

  document.title = currentSeo.title;
  setMetaTag('description', currentSeo.description);
  setMetaTag('application-name', siteName);
  setMetaTag('og:type', currentSeo.ogType ?? 'website', true);
  setMetaTag('og:site_name', siteName, true);
  setMetaTag('og:locale', ogLocale(defaultLocale), true);
  setMetaTag('og:title', currentSeo.title, true);
  setMetaTag('og:description', currentSeo.description, true);
  setMetaTag('og:image', currentSeo.ogImage ?? '/og-image.png', true);
  setMetaTag('og:image:alt', currentSeo.title, true);
  setMetaTag('og:url', currentSeo.canonical, true);
  setMetaTag('twitter:card', currentSeo.twitterCard ?? 'summary_large_image');
  setMetaTag('twitter:title', currentSeo.title);
  setMetaTag('twitter:description', currentSeo.description);
  setMetaTag('twitter:image', currentSeo.ogImage ?? '/og-image.png');
  setLinkTag('canonical', currentSeo.canonical);
  setMetaTag('robots', currentSeo.robots ?? 'index, follow');
  setJsonLd(currentSeo.jsonLd);
}

export function getSeoForRoute(route: string, settings: { site_name: string; site_slogan: string }): SeoData {
  const origin = window.location.origin;
  const base: SeoData = {
    title: settings.site_name,
    description: settings.site_slogan,
    canonical: origin + route,
    ogType: 'website',
    ogImage: '/og-image.png',
    twitterCard: 'summary_large_image',
    robots: 'index, follow'
  };

  switch (route) {
    case '/':
    case '/index.html':
      return { ...base, title: `${settings.site_name} - ${settings.site_slogan}`, description: settings.site_slogan };

    case '/polls':
      return {
        ...base,
        title: `All Polls - ${settings.site_name}`,
        description: `Browse all open polls on ${settings.site_name}. ${settings.site_slogan}`
      };

    case '/about':
      return {
        ...base,
        title: `${t('seoAboutTitle')} - ${settings.site_name}`,
        description: t('seoAboutDescription')
          .replace('{name}', settings.site_name)
          .replace('{slogan}', settings.site_slogan)
      };

    case '/submit':
      return {
        ...base,
        title: `${t('seoSubmitTitle')} - ${settings.site_name}`,
        description: t('seoSubmitDescription')
          .replace('{name}', settings.site_name)
          .replace('{slogan}', settings.site_slogan),
        robots: 'noindex, follow'
      };

    case '/login':
      return {
        ...base,
        title: `Sign In - ${settings.site_name}`,
        description: `Sign in to access ${settings.site_name} features.`,
        robots: 'noindex, nofollow'
      };

    case '/register':
      return {
        ...base,
        title: `Sign Up - ${settings.site_name}`,
        description: `Create an account on ${settings.site_name}.`,
        robots: 'noindex, nofollow'
      };

    case '/reset':
      return {
        ...base,
        title: `Reset Password - ${settings.site_name}`,
        description: `Reset your ${settings.site_name} password.`,
        robots: 'noindex, nofollow'
      };

    default:
      if (route.startsWith('/account')) {
        return {
          ...base,
          title: `My Account - ${settings.site_name}`,
          description: `Manage your account and polls on ${settings.site_name}.`,
          robots: 'noindex, nofollow'
        };
      }
      if (route.startsWith('/poll/')) {
        const pollId = route.split('/').pop();
        return {
          ...base,
          title: `${t('pollPrefix')} #${pollId} - ${settings.site_name}`,
          description: `Vote on poll #${pollId} on ${settings.site_name}.`,
          ogType: 'article',
          canonical: `${origin}/poll/${pollId}`
        };
      }
      if (route.startsWith('/vote/')) {
        const pollId = route.split('/').pop();
        return {
          ...base,
          title: `${t('pollPrefix')} #${pollId} - ${settings.site_name}`,
          description: `Vote on poll #${pollId} on ${settings.site_name}.`,
          ogType: 'article',
          canonical: `${origin}/poll/${pollId}`
        };
      }
      if (route.startsWith('/topic/')) {
        const topicSlug = route.split('/').pop();
        return {
          ...base,
          title: `${topicSlug} - ${settings.site_name}`,
          description: `Browse polls about ${topicSlug} on ${settings.site_name}.`,
          ogType: 'website',
          canonical: `${origin}/topic/${topicSlug}`
        };
      }
      // Unknown route
      return {
        ...base,
        title: `Page Not Found - ${settings.site_name}`,
        description: `The page you're looking for doesn't exist on ${settings.site_name}.`,
        robots: 'noindex, nofollow'
      };
  }
}

export function resetSeo(): void {
  updateSeo(DEFAULT_SEO);
}