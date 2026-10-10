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
//   TURNSTILE_SITE_KEY  public Turnstile site key for the login form
//   ADMIN_ORIGIN        extra origin allowed for cookie-authenticated mutations

import { authenticate, enforceSameOrigin, type AdminEnv } from './auth';
import { handleAdminsRequest } from './api/admins';
import { handleAuditRequest } from './api/audit';
import { handleCommentsRequest } from './api/comments';
import { handleOverviewRequest } from './api/overview';
import { handlePollsRequest } from './api/polls';
import { handleProposalsRequest } from './api/proposals';
import { handleSessionRequest, handleSetupRequest } from './api/session';
import { handleSettingsRequest } from './api/settings';
import { renderDashboard } from './ui';

export interface Env extends AdminEnv {}

const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

const htmlSecurityHeaders = (nonce: string): Record<string, string> => ({
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}' ${TURNSTILE_ORIGIN}`,
    `connect-src 'self' ${TURNSTILE_ORIGIN}`,
    `frame-src ${TURNSTILE_ORIGIN}`,
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer'
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return Response.json({ ok: true, worker: 'chinapoll-admin' });
    }

    if (url.pathname === '/favicon.ico') {
      return new Response(null, { status: 204 });
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const nonce = crypto.randomUUID().replace(/-/g, '');
      return new Response(renderDashboard(nonce), {
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
      if (url.pathname === '/api/admin/proposals' || url.pathname.startsWith('/api/admin/proposals/')) {
        return handleProposalsRequest(request, url, env, actor);
      }
      if (url.pathname === '/api/admin/polls' || url.pathname.startsWith('/api/admin/polls/')) {
        return handlePollsRequest(request, url, env, actor);
      }
      if (url.pathname === '/api/admin/comments' || url.pathname.startsWith('/api/admin/comments/')) {
        return handleCommentsRequest(request, url, env, actor);
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
} satisfies ExportedHandler<Env>;
