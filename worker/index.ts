import { handleProposalClaimRequest, handleProposalRequest } from './api/proposal';
import { handleStatsRequest } from './api/stats';
import { handleVoteRequest, handleVoteStatusRequest } from './api/vote';
import { handleCommentsRequest } from './api/comments';
import { handleIssuesRequest } from './api/issues';

export interface Env {
  DB: D1Database;
  TURNSTILE_SECRET_KEY?: string;
  SERVER_SECRET?: string;
  READ_ONLY_MODE?: string;
  TURNSTILE_SKIP?: string;
  VOTE_RATE_LIMIT_PER_IP_BUCKET_PER_HOUR?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return new Response(JSON.stringify({ ok: true, status: 'healthy' }), {
        headers: { 'content-type': 'application/json' }
      });
    }

    if (url.pathname.startsWith('/api/stats/')) {
      return handleStatsRequest(request, url, env as any);
    }

    if (url.pathname === '/api/issues' || url.pathname.startsWith('/api/issues/')) {
      return handleIssuesRequest(request, url, env);
    }

    if (url.pathname === '/api/comments' || url.pathname.startsWith('/api/comments/')) {
      return handleCommentsRequest(request, url, env as any);
    }

    if (url.pathname === '/api/vote') {
      return handleVoteRequest(request, env as any);
    }

    if (url.pathname === '/api/vote/status') {
      return handleVoteStatusRequest(request, env as any);
    }

    if (url.pathname === '/api/proposal/claim') {
      return handleProposalClaimRequest(request, env);
    }

    if (url.pathname === '/api/proposal') {
      return handleProposalRequest(request, env as any);
    }

    return new Response('Not found', { status: 404 });
  }
} satisfies ExportedHandler<Env>;
