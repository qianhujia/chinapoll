// Standalone admin Worker for ChinaPoll.
//
// This Worker is deployed separately from the public application Worker and
// binds to the same D1 database. It serves a browser dashboard plus a JSON API
// for reviewing submissions, adjusting polls, moderating comments, managing
// admin users, reviewing the audit log, and updating application settings.
//
// Admin users sign in with a username and password (see admin_users). The first
// admin is a super admin; later admins are regular admins and cannot read the
// audit log. Optional environment variables:
//   TURNSTILE_SITE_KEY    public Turnstile site key for the login form
//   TURNSTILE_SECRET_KEY  private Turnstile key used to verify login tokens; the
//                         login form requires a token only when both keys are set
//   ADMIN_ORIGIN          extra origin allowed for cookie-authenticated mutations

import { authenticate, enforceSameOrigin, type AdminEnv } from './auth';
import { handleAdminsRequest } from './api/admins';
import { handleAuditRequest } from './api/audit';
import { handleTopicsRequest } from './api/categories';
import { handleCommentsRequest } from './api/comments';
import { handleOverviewRequest } from './api/overview';
import { handlePollsRequest } from './api/polls';
import { handleReportsRequest } from './api/reports';
import { handleUsersRequest } from './api/users';
import { handleSessionRequest, handleSetupRequest } from './api/session';
import { handleSettingsRequest } from './api/settings';
import { renderDashboard } from './ui';
import { isTurnstileEnabled } from '../worker/services/turnstile';

export interface Env extends AdminEnv {}

// Durable Object classes referenced by the bindings in wrangler.toml.
export { RateLimiter } from '../worker/services/rateLimiter';
export { PasswordHasher } from '../worker/services/passwordHasher';

const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

// The dashboard is a single page with a dedicated URL per view. Every known
// view path serves the same HTML so direct navigation, bookmarks, sharing, and
// browser refresh all work; the client resolves the view from the pathname.
const DASHBOARD_PATHS = new Set([
  '/',
  '/index.html',
  '/overview',
  '/polls',
  '/topics',
  // Legacy alias for the topics view, kept so old bookmarks keep working.
  '/categories',
  '/reports',
  // The reports view is one page per queue, mirroring the settings pages.
  '/reports/polls',
  '/reports/comments',
  '/comments',
  '/users',
  '/admins',
  '/audit',
  '/settings',
  // The settings section is one page per category. Every category has its own
  // URL so the pages can be linked, bookmarked, and reloaded.
  '/settings/general',
  '/settings/appearance',
  '/settings/polls',
  '/settings/auth',
  '/settings/reports',
  '/settings/ai',
  '/settings/publishing',
  '/settings/advanced'
]);

// The document's own headers. The baseline that every admin response shares (no
// store, no framing, no sniffing, no referrer, HSTS) comes from
// `withSecurityHeaders` below; this builder adds the content type and the policy,
// which needs the per-document nonce.
const htmlSecurityHeaders = (nonce: string): Record<string, string> => ({
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}' ${TURNSTILE_ORIGIN}`,
    `connect-src 'self' ${TURNSTILE_ORIGIN} data:`,
    `frame-src ${TURNSTILE_ORIGIN}`,
    // A logo or favicon may be previewed from an https URL the admin pasted.
    "img-src 'self' data: https:",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; ')
});

// Security headers applied to every admin response (mirrors `withSecurityHeaders`
// in worker/index.ts). The dashboard is a private console, so nothing it returns
// may be stored or framed, and HSTS is set because a browser only learns it from a
// response that actually reaches the browser. An image or other non-document
// response the future adds to this Worker is covered too, rather than needing to
// remember the list.
function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
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

// The routes themselves. The default export wraps what this returns, so the
// routing code below never repeats the header list.
const router = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return Response.json({ ok: true, worker: 'chinapoll-admin' });
    }

    if (url.pathname === '/favicon.ico') {
      return new Response(null, { status: 204 });
    }

    if (DASHBOARD_PATHS.has(url.pathname)) {
      const nonce = crypto.randomUUID().replace(/-/g, '');
      return new Response(renderDashboard(nonce, isTurnstileEnabled(env)), {
        headers: htmlSecurityHeaders(nonce)
      });
    }

    // Session status, login, and logout are handled without a prior session.
    if (url.pathname === '/api/admin/session') {
      return handleSessionRequest(request, env);
    }

    // First-run setup creates the first admin user and is disabled afterwards.
    if (url.pathname === '/api/admin/setup') {
      return handleSetupRequest(request, env);
    }

    if (url.pathname.startsWith('/api/admin/')) {
      const auth = await authenticate(request, env);
      if (!auth.ok) return auth.response;

      const csrfError = enforceSameOrigin(request, env, auth.context);
      if (csrfError) return csrfError;

      const actor = auth.context.actor;

      if (url.pathname === '/api/admin/overview') {
        return handleOverviewRequest(request, env);
      }
      if (url.pathname === '/api/admin/polls' || url.pathname.startsWith('/api/admin/polls/')) {
        return handlePollsRequest(request, url, env, actor);
      }
      if (url.pathname === '/api/admin/topics' || url.pathname.startsWith('/api/admin/topics/')) {
        return handleTopicsRequest(request, url, env, actor);
      }
      if (url.pathname === '/api/admin/reports' || url.pathname.startsWith('/api/admin/reports/')) {
        return handleReportsRequest(request, url, env, actor);
      }
      if (url.pathname === '/api/admin/comments' || url.pathname.startsWith('/api/admin/comments/')) {
        return handleCommentsRequest(request, url, env, actor);
      }
      if (url.pathname === '/api/admin/users' || url.pathname.startsWith('/api/admin/users/')) {
        return handleUsersRequest(request, url, env, actor);
      }
      if (url.pathname === '/api/admin/admins' || url.pathname.startsWith('/api/admin/admins/')) {
        return handleAdminsRequest(request, url, env, actor);
      }
      if (url.pathname === '/api/admin/audit') {
        return handleAuditRequest(request, url, env, actor);
      }
      if (url.pathname === '/api/admin/settings' || url.pathname.startsWith('/api/admin/settings/')) {
        return handleSettingsRequest(request, url, env, actor);
      }
      return Response.json({ message: 'not found' }, { status: 404 });
    }

    return new Response('Not found', { status: 404 });
  }
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return withSecurityHeaders(await router.fetch(request, env));
    } catch (error) {
      // Structured error, never logs headers, bodies, cookies, or addresses.
      console.error(JSON.stringify({
        route: new URL(request.url).pathname,
        status: 500,
        error: error instanceof Error ? error.message : String(error)
      }));
      return withSecurityHeaders(Response.json({ message: 'internal error' }, { status: 500 }));
    }
  }
} satisfies ExportedHandler<Env>;
