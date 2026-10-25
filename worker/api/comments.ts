// Comment listing and submission.
//
// Comments require a signed-in account for the waiting-period gate, but the
// public API never exposes a username. Public identifiers are random so the
// global insertion order is not revealed. Rate limiting is per account and lives
// in the RateLimiter Durable Object.
//
// A comment also stores the poster's `author_mark` (see worker/services/author.ts)
// so the account dashboard can list and delete the comments that account posted.
// The mark is never published: readers still see an anonymous comment.

import type { HandlerEnv } from '../index';
import { toHex } from '../../shared/crypto';
import { checkRateLimit } from '../services/rateLimit';
import { enforceSameOrigin } from '../services/csrf';
import { requireUser } from '../services/session';
import { checkAccountAge } from '../services/users';
import { PollMode, PollStatus } from '../enums';
import { apiError } from '../../shared/http';

const MAX_PAGE_SIZE = 100;
const MIN_COMMENT_LENGTH = 5;
const MAX_COMMENT_LENGTH = 140;
const DEFAULT_COMMENT_RATE_LIMIT = '3/h';
const DEFAULT_COMMENT_DELAY_MINUTES = 10;

function publicId(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(8)));
}

export async function handleCommentsRequest(request: Request, url: URL, env: HandlerEnv): Promise<Response> {
  if (request.method === 'POST') {
    return handleCommentSubmission(request, env);
  }

  if (request.method !== 'GET') {
    return apiError('METHOD_NOT_ALLOWED', 405);
  }

  const pollId = Number(url.pathname.split('/').pop() ?? '0');
  const page = Number(url.searchParams.get('page') ?? '1');
  const pageSize = Number(url.searchParams.get('pageSize') ?? '30');

  if (!Number.isSafeInteger(pollId) || pollId < 1
    || !Number.isSafeInteger(page) || page < 1
    || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    return apiError('INVALID_PAGINATION', 400);
  }

  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) {
    return apiError('INVALID_PAGINATION', 400);
  }

  const countResult = await env.DB.prepare(
    'SELECT COUNT(*) AS total FROM comments WHERE poll_id = ?'
  ).bind(pollId).first();

  // Ordering by created_at then the random public id keeps the order within an
  // hour from matching insertion order.
  const commentResult = await env.DB.prepare(
    `SELECT public_id, comment, created_at FROM comments
     WHERE poll_id = ?
     ORDER BY created_at DESC, public_id DESC LIMIT ? OFFSET ?`
  ).bind(pollId, pageSize, offset).all<{ public_id: string | null; comment: string; created_at: number }>();

  return Response.json({
    pollId,
    page,
    pageSize,
    total: Number(countResult?.total ?? 0),
    comments: (commentResult.results ?? []).map((row) => ({
      id: row.public_id,
      comment: row.comment,
      createdAt: new Date(row.created_at * 1000).toISOString()
    }))
  }, {
    headers: { 'cache-control': 'no-store' }
  });
}
async function handleCommentSubmission(request: Request, env: HandlerEnv): Promise<Response> {
  if (request.method !== 'POST') {
    return apiError('METHOD_NOT_ALLOWED', 405);
  }

  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;

  const csrf = enforceSameOrigin(request, { viaCookie: true });
  if (csrf) return csrf;

  const delayMinutes = Number(env.user_comment_delay_minutes ?? DEFAULT_COMMENT_DELAY_MINUTES);
  const accountAge = checkAccountAge(auth.user.createdAt, delayMinutes);
  if (!accountAge.allowed) {
    return apiError('ACCOUNT_TOO_NEW_COMMENT', 403, {
      params: { minutes: delayMinutes },
      extra: { remainingMinutes: accountAge.remainingMinutes }
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError('INVALID_JSON', 400);
  }

  if (typeof body !== 'object' || body === null || !('pollId' in body) || !('comment' in body)) {
    return apiError('COMMENT_REQUIRED', 400);
  }

  const pollId = Number(body.pollId);
  const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
  if (!Number.isSafeInteger(pollId) || pollId < 1) {
    return apiError('INVALID_POLL_ID', 400);
  }
  if (comment.length < MIN_COMMENT_LENGTH || comment.length > MAX_COMMENT_LENGTH) {
    return apiError('COMMENT_LENGTH', 400);
  }

  const poll = await env.DB.prepare(
    'SELECT status, mode, start_at, end_at FROM polls WHERE id = ?'
  ).bind(pollId).first<{ status: number; mode: number; start_at: number | null; end_at: number | null }>();
  if (!poll) {
    return apiError('POLL_NOT_FOUND', 404);
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const withinDeadline = poll.mode !== PollMode.Deadline
    || ((poll.start_at === null || poll.start_at <= nowSeconds)
      && (poll.end_at === null || nowSeconds <= poll.end_at));
  if (poll.status !== PollStatus.Open || !withinDeadline) {
    return apiError('POLL_NOT_OPEN', 409);
  }

  const limited = await checkRateLimit(env, 'comment', `user:${auth.user.id}`, env.comment_rate_limit, DEFAULT_COMMENT_RATE_LIMIT);
  if (!limited.allowed) {
    return apiError('COMMENT_RATE_LIMIT', 429);
  }

  // Coarsen the timestamp to the hour so it cannot be correlated with a session
  // or edge-log timestamp.
  const coarseNow = nowSeconds - (nowSeconds % 3600);
  const id = publicId();
  // The account dashboard lists and deletes the comments it posted, so the row
  // stores the poster's fixed author mark. The mark is never published, so readers
  // still see an anonymous comment.
  await env.DB.prepare(
    'INSERT INTO comments (poll_id, comment, created_at, public_id, author_mark) VALUES (?, ?, ?, ?, ?)'
  ).bind(pollId, comment, coarseNow, id, auth.user.authorMark).run();

  return Response.json({ ok: true, id }, { status: 201 });
}