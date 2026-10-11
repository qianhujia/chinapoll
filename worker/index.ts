// Public application Worker: JSON API plus the SPA and text-only read paths.
//
// The Worker binds to D1 for persistent data and to a RateLimiter Durable Object
// for atomic, storage-free rate limiting. It never stores a raw client address:
// network buckets are keyed and rotated daily with IP_HASH_KEY (see
// worker/services/ip.ts).

import { handleProposalRequest } from './api/proposal';
import { handleStatsRequest } from './api/stats';
import { handleVoteRequest, handleVoteStatusRequest } from './api/vote';
import { handleCommentsRequest } from './api/comments';
import { handlePollsRequest } from './api/polls';
import { handleSnapshotRequest } from './api/snapshots';
import {
  DEFAULT_PUBLIC_SETTINGS,
  loadPublicSettings,
  handlePublicSettingsRequest,
  type PublicSettings
} from './api/settings';
import { handleAuthRequest } from './api/auth';
import { handleUserRequest } from './api/user';
import { makeSnapshot } from './services/snapshot';
import { runMaintenanceTasks } from './services/maintenance';

export interface Env {
  DB: D1Database;
  RATE_LIMITER: DurableObjectNamespace;
  IP_HASH_KEY?: string;
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

// Privacy headers applied to every response. These forbid caching and storage of
// referrers, and harden against sniffing and framing.
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

async function loadSettings(env: Env): Promise<PublicSettings> {
  try {
    return await loadPublicSettings(env.DB);
  } catch (error) {
    // A malformed stored setting must not take the whole site down.
    console.error('settings load failed', error);
    return { ...DEFAULT_PUBLIC_SETTINGS };
  }
}

async function handleHealth(env: Env): Promise<Response> {
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
  return Response.json({ ok: db === 'ok', build: buildSha(env), db, lastSnapshotAt });
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === '/api/health') return handleHealth(env);

  const settings = await loadSettings(env);
  const envWithSettings: HandlerEnv = { ...env, ...settings };

  if (url.pathname === '/api/settings/public') {
    return handlePublicSettingsRequest(request, envWithSettings);
  }
  if (url.pathname.startsWith('/api/stats/')) {
    return handleStatsRequest(request, url, envWithSettings);
  }
  if (url.pathname === '/api/polls' || url.pathname.startsWith('/api/polls/')) {
    return handlePollsRequest(request, url, envWithSettings);
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
  if (url.pathname === '/api/snapshots' || url.pathname.startsWith('/api/snapshots/')) {
    return handleSnapshotRequest(request, url, envWithSettings);
  }
  if (url.pathname === '/api/auth' || url.pathname.startsWith('/api/auth/')) {
    return handleAuthRequest(request, url, envWithSettings);
  }
  if (url.pathname.startsWith('/api/user/')) {
    return handleUserRequest(request, url, envWithSettings);
  }

  return new Response('Not found', { status: 404 });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return withSecurityHeaders(await route(request, env));
    } catch (error) {
      // Structured error, never logs headers, bodies, cookies, or addresses.
      console.error(JSON.stringify({
        route: new URL(request.url).pathname,
        status: 500,
        error: error instanceof Error ? error.message : String(error)
      }));
      return withSecurityHeaders(Response.json({ message: 'internal error' }, { status: 500 }));
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

// Durable Object class referenced by the RATE_LIMITER binding in wrangler.toml.
export { RateLimiter } from './services/rateLimiter';

// Re-exported for tests and the scheduled handler.
export { makeSnapshot };
export type { PublicSettings };