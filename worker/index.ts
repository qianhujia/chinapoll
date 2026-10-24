// Public application Worker: JSON API plus the SPA shell.
//
 // The Worker binds to D1 for persistent data and to a RateLimiter Durable Object
 // for atomic rate limiting. It never stores a raw client address: network
 // buckets are keyed and rotated with SERVER_HMAC_KEY (see worker/services/ip.ts).
 // Every request is routed through the Worker: the JSON API is answered here, and
 // other paths are served from the assets binding so the HTML document gets a
 // Content Security Policy on every route, including deep links such as /poll/12.

import { handleProposalRequest } from './api/proposal';
import { handleAiRequest } from './api/ai';
import { handleStatsRequest } from './api/stats';
import { handleVoteRequest, handleVoteStatusRequest } from './api/vote';
import { handleCommentsRequest } from './api/comments';
import { handlePollsRequest } from './api/polls';
import { handleTopicsRequest } from './api/categories';
import { handleReportRequest } from './api/reports';
import { handleViewRequest } from './api/views';
import { handleSnapshotRequest } from './api/snapshots';
import {
  DEFAULT_PUBLIC_SETTINGS,
  loadPublicSettings,
  handlePublicSettingsRequest,
  type PublicSettings
} from './api/settings';
import {
  buildBootstrapPayload,
  injectBootstrapScript,
  renderBootstrapScript
} from './services/bootstrap';
import { handleAuthRequest } from './api/auth';
import { handleUserRequest } from './api/user';
import { brandingKeyFromPath, handleBrandingRequest } from './api/branding';
import { makeSnapshot } from './services/snapshot';
import { runMaintenanceTasks } from './services/maintenance';
import { publishHealth } from './services/publisher';
import { isValidServerKey, serverHmacKey } from './services/ip';
import {
  buildBreadcrumbJsonLd,
  buildMetaTags,
  buildPollListJsonLd,
  buildSeoContext,
  buildWebsiteJsonLd,
  getHomeSeoContext,
  getPollsListSeoContext,
  getAboutSeoContext,
  getSubmitSeoContext,
  getAuthSeoContext,
  getAccountSeoContext,
  getNotFoundSeoContext,
  getPollSeoContext,
  injectSeoIntoHtml,
  type SeoContext
} from './services/seo';
import {
  applyHtmlLang,
  injectAppBody,
  loadHomeSsrData,
  loadPollSsrData,
  renderAboutBody,
  renderHomeBody,
  renderPollBody,
  translatorFor,
  type HomeSsrData
} from './services/ssr';
import { getPollStatusLabel, PollMode, PollStatus } from './enums';
import { apiError } from '../shared/http';

export interface Env {
  DB: D1Database;
  RATE_LIMITER: DurableObjectNamespace;
  /** Durable Object that performs PBKDF2 password hashing off the request CPU path. */
  PASSWORD_HASHER: DurableObjectNamespace;
  /** One per-poll Durable Object that buffers view counts and flushes them to D1. */
  VIEW_COUNTER: DurableObjectNamespace;
  ASSETS: Fetcher;
  /** Cloudflare Workers AI binding, used only by the optional AI assistance. */
  AI: Ai;
  /** Public Turnstile site key. Turnstile is enabled only when both keys are set. */
  TURNSTILE_SITE_KEY?: string;
  /** Private Turnstile key used for server-side token verification. */
  TURNSTILE_SECRET_KEY?: string;
  SERVER_HMAC_KEY?: string;
  BUILD_SHA?: string;
}

// Handlers receive the bindings plus the merged public settings.
export type HandlerEnv = Env & PublicSettings;

// Deployment build identifier. Vite injects __BUILD_SHA__ for the SPA build and
// the value is optional here so the Worker also runs locally without it.
declare const __BUILD_SHA__: string | undefined;

function buildSha(env: Env): string {
  if (env.BUILD_SHA) return env.BUILD_SHA;
  return typeof __BUILD_SHA__ === 'string' ? __BUILD_SHA__ : 'dev';
}

// Content Security Policy for the SPA document. Only the site itself and the
 // Turnstile host may be used; inline styles are allowed because the SPA sets
 // style attributes. Kept in sync with scripts allowed by the frontend.
 const PUBLIC_CSP = [
   "default-src 'none'",
   "script-src 'self' https://challenges.cloudflare.com",
   "style-src 'self' 'unsafe-inline'",
   "connect-src 'self' https://challenges.cloudflare.com",
   "frame-src https://challenges.cloudflare.com",
   // Images come from this origin, from an inline payload, or from the host of a
   // logo or favicon URL the admin pasted (https only).
   "img-src 'self' data: https:",
   "font-src 'self' data:",
   "base-uri 'none'",
   "form-action 'self'",
   "frame-ancestors 'none'"
 ].join('; ');

 // True for the responses that must never be stored by a browser or an
 // intermediary: an HTML document (it carries the viewer's settings and the
 // bootstrap island), a JSON API response (per-viewer answers), or an error. A
 // static asset keeps whatever the asset layer sent - the SPA bundle is
 // content-hashed and the dictionaries are stable - so a repeat visit reuses them
 // instead of downloading the bundle again.
 function isPrivateResponse(response: Response, pathname: string): boolean {
   if (pathname.startsWith('/api/')) return true;
   if ((response.headers.get('content-type') ?? '').includes('text/html')) return true;
   return response.status >= 400;
 }

 // Privacy headers applied to every response; `noStore` also removes the ability
 // to store it.
 function withSecurityHeaders(response: Response, noStore: boolean): Response {
   const headers = new Headers(response.headers);
   if (noStore) {
     headers.set('cache-control', 'no-store');
   }
   headers.set('referrer-policy', 'no-referrer');
   headers.set('x-content-type-options', 'nosniff');
   headers.set('x-frame-options', 'DENY');
   headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
   return new Response(response.body, {
     status: response.status,
     statusText: response.statusText,
     headers
   });
 }

 // Attaches the CSP to the HTML document returned by the assets layer.
 function withHtmlCsp(response: Response): Response {
   if (!(response.headers.get('content-type') ?? '').includes('text/html')) return response;
   const headers = new Headers(response.headers);
   headers.set('content-security-policy', PUBLIC_CSP);
   return new Response(response.body, {
     status: response.status,
     statusText: response.statusText,
     headers
   });
 }

// Server-renders the public page: route-specific <head> metadata plus a
// crawlable body for the routes search engines index. The client bundle
// re-renders the same container when it boots. `status` is the HTTP status the
// document carries, so an unknown path answers 404 instead of 200.
interface PublicPage {
  seo: SeoContext;
  body: string;
  status: number;
}

function readPageParam(search: URLSearchParams, key = 'page'): number {
  const page = Number(search.get(key) ?? '1');
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

async function buildPublicPage(
  pathname: string,
  search: URLSearchParams,
  settings: PublicSettings,
  origin: string,
  env: Env
): Promise<PublicPage> {
  // The server-rendered copy follows the site's default locale, matching what
  // the client bundle renders a moment later.
  const t = translatorFor(settings.default_locale);
  const page = readPageParam(search);
  const query = (search.get('q') ?? '').trim().slice(0, 100);

  if (pathname === '/' || pathname === '/index.html' || pathname === '/polls') {
    const activeTopic = (search.get('topic') ?? search.get('category') ?? '').trim();
    let data: HomeSsrData | null = null;
    try {
      data = await loadHomeSsrData(env.DB, {
        pageSize: settings.polls_per_page,
        page,
        query,
        topicSlug: activeTopic
      });
    } catch (error) {
      console.error('ssr poll list failed', error);
    }
    const polls = data?.polls ?? [];
    const base = pathname === '/polls'
      ? getPollsListSeoContext(settings, origin)
      : getHomeSeoContext(settings, origin);
    return {
      seo: {
        ...base,
        jsonLd: [buildWebsiteJsonLd(settings, origin), buildPollListJsonLd(polls, settings, origin)]
      },
      body: renderHomeBody({
        settings,
        topics: data?.topics ?? [],
        topicTotal: data?.topicTotal ?? 0,
        polls,
        page: data?.page ?? page,
        totalPages: data?.totalPages ?? 1,
        query,
        activeTopic,
        totalPolls: data?.totalPolls ?? 0,
        totalVotes: data?.totalVotes ?? 0,
        showHero: (data?.page ?? page) === 1 && query === '' && activeTopic === ''
      }, t),
      status: 200
    };
  }
  if (pathname.startsWith('/topic/')) {
    const topicSlug = pathname.slice('/topic/'.length);
    if (!/^[a-z0-9-]{2,40}$/.test(topicSlug)) {
      return { seo: getNotFoundSeoContext(settings, origin), body: '', status: 404 };
    }
    let data: HomeSsrData | null = null;
    try {
      data = await loadHomeSsrData(env.DB, {
        pageSize: settings.polls_per_page,
        page,
        query: '',
        topicSlug
      });
    } catch (error) {
      console.error('ssr topic failed', error);
    }
    const polls = data?.polls ?? [];
    const name = data?.topics.find((topic) => topic.slug === topicSlug)?.name ?? topicSlug;
    const topicUrl = `${origin}/topic/${topicSlug}`;
    return {
      seo: buildSeoContext(`/topic/${topicSlug}`, settings, origin, {
        title: `${name} - ${settings.site_name}`,
        description: `Browse polls about ${name} on ${settings.site_name}.`,
        canonical: topicUrl,
        ogType: 'website',
        jsonLd: [
          buildBreadcrumbJsonLd([
            { name: settings.site_name, url: `${origin}/` },
            { name, url: topicUrl }
          ]),
          buildPollListJsonLd(polls, settings, origin)
        ]
      }),
      body: renderHomeBody({
        settings,
        topics: data?.topics ?? [],
        topicTotal: data?.topicTotal ?? 0,
        polls,
        page: data?.page ?? page,
        totalPages: data?.totalPages ?? 1,
        query: '',
        activeTopic: topicSlug,
        totalPolls: data?.totalPolls ?? 0,
        totalVotes: data?.totalVotes ?? 0,
        showHero: (data?.page ?? page) === 1 && topicSlug === ''
      }, t),
      status: 200
    };
  }

  if (pathname.startsWith('/poll/') || pathname.startsWith('/vote/')) {
    const pollId = Number(pathname.slice(pathname.indexOf('/', 1) + 1));
    if (Number.isSafeInteger(pollId) && pollId > 0) {
      let poll: Awaited<ReturnType<typeof loadPollSsrData>> = null;
      try {
        poll = await loadPollSsrData(env.DB, pollId);
      } catch (error) {
        console.error('ssr poll failed', error);
      }
      if (poll) {
        return {
          seo: getPollSeoContext(
            { number: poll.number, title: poll.title, description: poll.description, status: getPollStatusLabel(poll.status) },
            settings,
            origin
          ),
          body: renderPollBody(poll, settings, t),
          status: 200
        };
      }
    }
    return { seo: getNotFoundSeoContext(settings, origin), body: '', status: 404 };
  }

  if (pathname === '/about') {
    return { seo: getAboutSeoContext(settings, origin, t), body: renderAboutBody(settings, t), status: 200 };
  }

  if (pathname === '/submit') {
    return { seo: getSubmitSeoContext(settings, origin, t), body: '', status: 200 };
  }

  if (pathname === '/login' || pathname === '/register' || pathname === '/reset') {
    return { seo: getAuthSeoContext(pathname, settings, origin), body: '', status: 200 };
  }

  if (pathname === '/account' || pathname.startsWith('/account/')) {
    return { seo: getAccountSeoContext(settings, origin), body: '', status: 200 };
  }

  // An unknown path still gets the client-rendered not-found view, but the
  // document answers 404 so crawlers do not index it.
  return { seo: getNotFoundSeoContext(settings, origin), body: '', status: 404 };
}

// Applies the page's metadata and server-rendered body to the document shell
// returned by the assets binding. The shell keeps its original cache headers;
// only the status may change (a not-found page answers 404).
async function withSeoMetadata(
  response: Response,
  request: Request,
  settings: PublicSettings,
  origin: string,
  env: Env
): Promise<Response> {
  if (!(response.headers.get('content-type') ?? '').includes('text/html')) {
    return response;
  }

  const url = new URL(request.url);
  const page = await buildPublicPage(url.pathname, url.searchParams, settings, origin, env);
  const metaTags = buildMetaTags(page.seo, settings, origin);
  const shell = applyHtmlLang(await response.text(), settings.default_locale);
  const rendered = injectAppBody(injectSeoIntoHtml(shell, metaTags, page.seo.title), page.body);

  // The bootstrap island carries the settings, the translation dictionary, and -
  // on a poll page that was found - the poll data, so the client does not issue
  // those requests right after the document. A poll page that answered 404 has no
  // data to embed.
  const pollPath = page.status === 200 ? /^\/(?:poll|vote)\/(\d+)$/.exec(url.pathname) : null;
  const envWithSettings: HandlerEnv = { ...env, ...settings };
  // `settings` is passed on its own: the merged environment also holds the bindings
  // and the server secret, which must never be serialized into the document.
  const payload = await buildBootstrapPayload(
    envWithSettings,
    settings,
    origin,
    pollPath
      ? {
        id: Number(pollPath[1]),
        commentsPage: readPageParam(url.searchParams, 'commentsPage'),
        commentsPageSize: settings.comments_per_page
      }
      : undefined
  );
  const html = injectBootstrapScript(rendered, renderBootstrapScript(payload));

  return new Response(html, {
    status: page.status,
    headers: response.headers
  });
}

// Settings are cached per isolate for a short window so every request does not
// re-read them. A change therefore takes up to 30 seconds to apply.
const SETTINGS_TTL_MS = 30_000;
let settingsCache: { settings: PublicSettings; loadedAt: number; error: boolean } | null = null;

async function loadSettings(env: Env): Promise<{ settings: PublicSettings; error: boolean }> {
  const now = Date.now();
  if (settingsCache && now - settingsCache.loadedAt < SETTINGS_TTL_MS) {
    return { settings: settingsCache.settings, error: settingsCache.error };
  }
  try {
    const settings = await loadPublicSettings(env.DB);
    settingsCache = { settings, loadedAt: now, error: false };
    return { settings, error: false };
  } catch (error) {
    // Fail closed: a malformed stored setting must not silently turn off
    // read-only mode or the vote threshold, so the site degrades to read-only.
    console.error('settings load failed', error);
    const settings: PublicSettings = { ...DEFAULT_PUBLIC_SETTINGS, read_only_mode: true };
    settingsCache = { settings, loadedAt: now, error: true };
    return { settings, error: true };
  }
}
async function handleHealth(env: Env, settingsError: boolean): Promise<Response> {
  let db = 'ok';
  let lastSnapshotAt: string | null = null;
  try {
    await env.DB.prepare('SELECT 1').first();
    const row = await env.DB.prepare(
      'SELECT MAX(ts_hour) AS ts FROM stats_snapshots'
    ).first<{ ts: number | null }>();
    lastSnapshotAt = row?.ts ? new Date(Number(row.ts) * 1000).toISOString() : null;
  } catch {
    db = 'error';
  }
  // A missing or malformed SERVER_HMAC_KEY makes every vote, comment, and
  // account request fail with 503, so surface it here (and fail `ok`) before a
  // visitor tries to vote. The vote page maps that 503, and the 423 that
  // read-only mode returns, to localized messages.
  const serverKey = isValidServerKey(serverHmacKey(env));
  // Publish status is reported separately and never makes `ok` false: a failed
  // publish is visible in the admin dashboard but must not take the site down.
  const { lastPublishAt, publishError } = db === 'ok'
    ? await publishHealth(env)
    : { lastPublishAt: null, publishError: false };
  return Response.json({
    ok: db === 'ok' && !settingsError && serverKey,
    build: buildSha(env),
    db,
    serverKey,
    settingsError,
    lastSnapshotAt,
    lastPublishAt,
    publishError
  });
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const origin = url.origin;

  // Special static files served by the Worker (not from assets)
  if (url.pathname === '/robots.txt') {
    const robots = `User-agent: *
Allow: /

# Disallow authentication and account pages
Disallow: /login
Disallow: /register
Disallow: /reset
Disallow: /account/

# Disallow admin (separate subdomain)
Disallow: /api/

Sitemap: ${origin}/sitemap.xml
`;
    return withSecurityHeaders(new Response(robots, {
      headers: { 'content-type': 'text/plain; charset=utf-8' }
    }), true);
  }

  if (url.pathname === '/sitemap.xml') {
    const today = new Date().toISOString().split('T')[0];

    // Open polls and the enabled topic pages are the two dynamic groups.
    const pollResult = await env.DB.prepare(
      `SELECT number, updated_at FROM polls
       WHERE status = ? AND mode IN (?, ?)
       ORDER BY updated_at DESC LIMIT 5000`
    ).bind(PollStatus.Open, PollMode.Deadline, PollMode.Evergreen).all<{ number: number; updated_at: number }>();

    const topicResult = await env.DB.prepare(
      'SELECT slug FROM topics WHERE enabled = 1 ORDER BY position ASC, id ASC LIMIT 500'
    ).all<{ slug: string }>();

    const polls = (pollResult.results ?? []).map(row => ({
      url: `${origin}/poll/${row.number}`,
      lastmod: new Date(row.updated_at * 1000).toISOString().split('T')[0],
      changefreq: 'weekly',
      priority: '0.7'
    }));

    const topics = (topicResult.results ?? []).map(row => ({
      url: `${origin}/topic/${row.slug}`,
      lastmod: today,
      changefreq: 'daily',
      priority: '0.6'
    }));

    const staticUrls = [
      { url: `${origin}/`, lastmod: today, changefreq: 'daily', priority: '1.0' },
      { url: `${origin}/polls`, lastmod: today, changefreq: 'daily', priority: '0.9' },
      { url: `${origin}/about`, lastmod: today, changefreq: 'monthly', priority: '0.8' },
      { url: `${origin}/submit`, lastmod: today, changefreq: 'monthly', priority: '0.6' }
    ];

    const entry = (u: { url: string; lastmod: string; changefreq: string; priority: string }): string =>
      `  <url><loc>${u.url}</loc><lastmod>${u.lastmod}</lastmod><changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`;

    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${staticUrls.map(entry).join('\n')}
${topics.map(entry).join('\n')}
${polls.map(entry).join('\n')}
</urlset>`;

    return withSecurityHeaders(new Response(sitemap, {
      headers: { 'content-type': 'application/xml; charset=utf-8' }
    }), true);
  }

  // An uploaded logo or favicon is served from its own URL, so a page references
  // a short versioned URL instead of the stored base64 payload. A pasted image
  // URL needs no route here: the pages use it directly.
  if (brandingKeyFromPath(url.pathname)) {
    return handleBrandingRequest(request, url, env);
  }

  // The JSON API is answered by the Worker. Unknown API paths return JSON so
  // they never fall through to the single-page application shell.
  if (url.pathname.startsWith('/api/')) {
    const { settings, error: settingsError } = await loadSettings(env);

    if (url.pathname === '/api/health') return handleHealth(env, settingsError);

    const envWithSettings: HandlerEnv = { ...env, ...settings };

    if (url.pathname === '/api/settings/public') {
      return handlePublicSettingsRequest(request, env);
    }
    if (url.pathname === '/api/topics') {
      return handleTopicsRequest(request, envWithSettings);
    }
    if (url.pathname.startsWith('/api/stats/')) {
      return handleStatsRequest(request, url, envWithSettings);
    }
    if (url.pathname.startsWith('/api/polls/')) {
      // Poll sub-resources: reporting and view counting.
      if (url.pathname.endsWith('/report')) {
        return handleReportRequest(request, url, envWithSettings);
      }
      if (url.pathname.endsWith('/view')) {
        return handleViewRequest(request, url, envWithSettings);
      }
    }
    if (url.pathname === '/api/polls' || url.pathname.startsWith('/api/polls/')) {
      return handlePollsRequest(request, url, envWithSettings);
    }
    if (url.pathname.startsWith('/api/comments/') && url.pathname.endsWith('/report')) {
      // The comment report shares the reporting endpoint with the poll report.
      return handleReportRequest(request, url, envWithSettings);
    }
    if (url.pathname === '/api/comments' || url.pathname.startsWith('/api/comments/')) {
      return handleCommentsRequest(request, url, envWithSettings);
    }
    if (url.pathname === '/api/vote') {
      return handleVoteRequest(request, envWithSettings);
    }
    if (url.pathname === '/api/vote/status') {
      return handleVoteStatusRequest(request, envWithSettings);
    }
    if (url.pathname === '/api/proposal') {
      return handleProposalRequest(request, envWithSettings);
    }
    if (url.pathname.startsWith('/api/ai/')) {
      return handleAiRequest(request, url, envWithSettings);
    }
    if (url.pathname === '/api/snapshots' || url.pathname.startsWith('/api/snapshots/')) {
      return handleSnapshotRequest(request, url, envWithSettings);
    }
    if (url.pathname === '/api/auth' || url.pathname.startsWith('/api/auth/')) {
      return handleAuthRequest(request, url, envWithSettings);
    }
    if (url.pathname.startsWith('/api/user/')) {
      return handleUserRequest(request, url, envWithSettings);
    }

    return apiError('RESOURCE_NOT_FOUND', 404);
  }

  // Everything else, including the SPA shell and deep links such as `/poll/12`,
  // is served from the assets binding; the HTML document receives the CSP.
  // With `run_worker_first`, static assets still come from the assets layer.
  const { settings } = await loadSettings(env);

  const assetsResponse = await env.ASSETS.fetch(request);
  const withCsp = withHtmlCsp(assetsResponse);
  const withSeo = await withSeoMetadata(withCsp, request, settings, origin, env);

  return withSecurityHeaders(withSeo, isPrivateResponse(withSeo, url.pathname));
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      const response = await route(request, env);
      // A branding image is answered with its own immutable cache headers and a
      // version query (see api/branding.ts), so the wrapper leaves it alone.
      if (brandingKeyFromPath(url.pathname)) return response;
      // Only HTML documents, API responses, and errors are marked no-store. A
      // hashed asset keeps the cache headers the asset layer gave it (immutable in
      // production), so a second visit reuses it instead of downloading the bundle
      // again; the JSON API handlers set their own no-store.
      return withSecurityHeaders(response, isPrivateResponse(response, url.pathname));
    } catch (error) {
      // Structured error, never logs headers, bodies, cookies, or addresses.
      console.error(JSON.stringify({
        route: new URL(request.url).pathname,
        status: 500,
        error: error instanceof Error ? error.message : String(error)
      }));
      return withSecurityHeaders(apiError('INTERNAL_ERROR', 500), true);
    } finally {
      void ctx;
    }
  },

  // Hourly maintenance: write signed snapshots, advance the poll lifecycle, and
  // purge expired rows (see worker/services/maintenance.ts).
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runMaintenanceTasks(env));
  }
} satisfies ExportedHandler<Env>;

// Durable Object classes referenced by the bindings in wrangler.toml.
export { RateLimiter } from './services/rateLimiter';
export { PasswordHasher } from './services/passwordHasher';
export { ViewCounter } from './services/viewCounter';

// Re-exported for tests and the scheduled handler.
export { makeSnapshot };
export type { PublicSettings };