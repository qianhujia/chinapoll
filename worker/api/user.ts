// Self-service endpoints for the signed-in account.
//
// Every poll and comment a signed-in account writes stores one fixed
// `author_mark` value (see worker/services/author.ts). "My polls" and "my
// comments" are therefore ordinary paginated queries by that mark; the browser
// remembers nothing. The mark is never published, so readers still see anonymous
// content.

import type { HandlerEnv } from '../index';
import {
  buildClearSessionCookie,
  isSecureRequest,
  requireUser,
  type UserActor
} from '../services/session';
import { enforceSameOrigin } from '../services/csrf';
import { derivePasswordMaterialRemote } from '../services/passwordHasher';
import { parseUserPasswordHash } from '../../shared/password';
import { constantTimeEqual, wrapHex } from '../../shared/crypto';
import { generateRecoveryCode, normalizeRecoveryCode } from '../services/recovery';
import { recoveryWrapKeyHex } from '../services/author';
import { checkRateLimit } from '../services/rateLimit';
import { currentHour, writeSnapshotForPoll } from '../services/maintenance';
import { apiError } from '../../shared/http';

// Page size of "my polls" and "my comments".
const PAGE_SIZE = 20;

// Status and mode labels are mapped locally (rather than via worker/enums) so a
// poll that is still pending under review does not raise.
function pollStatusLabel(status: number): string {
  if (status === 1) return 'open';
  if (status === 2) return 'closed';
  if (status === 3) return 'archived';
  return 'pending';
}

function pollModeLabel(mode: number): string {
  return mode === 2 ? 'evergreen' : 'deadline';
}

type UserEnv = HandlerEnv;

function noStoreJson(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, {
    status,
    headers: { 'cache-control': 'no-store', ...headers }
  });
}

// Both dashboard list endpoints answer for a signed-in account. They are read-only,
// so the quota is generous: a real dashboard is unaffected while a stolen session is
// kept from making unlimited authenticated queries. It is a fixed internal limit
// rather than a setting, so an operator cannot remove it by accident. Both endpoints
// share one scope, so alternating between them cannot double the budget.
const USER_LIST_RATE_LIMIT = '60/h';

// Consumes one unit of the per-account dashboard quota. The key is the account id,
// never a network value.
async function userListAllowed(env: UserEnv, userId: number): Promise<boolean> {
  const limited = await checkRateLimit(env, 'user-list', `user:${userId}`, undefined, USER_LIST_RATE_LIMIT);
  return limited.allowed;
}

export async function handleUserRequest(request: Request, url: URL, env: UserEnv): Promise<Response> {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;

  // Every cookie-authenticated mutation must come from the site itself.
  const csrf = enforceSameOrigin(request, { viaCookie: true });
  if (csrf) return csrf;

  if (url.pathname === '/api/user/account') {
    if (request.method !== 'DELETE') return apiError('METHOD_NOT_ALLOWED', 405);
    return deleteAccount(request, env, auth.user);
  }

  if (url.pathname === '/api/user/polls') {
    if (request.method !== 'GET') return apiError('METHOD_NOT_ALLOWED', 405);
    if (!await userListAllowed(env, auth.user.id)) return apiError('RATE_LIMIT_EXCEEDED', 429);
    return listUserPolls(url, env, auth.user);
  }

  if (url.pathname === '/api/user/comments') {
    if (request.method !== 'GET') return apiError('METHOD_NOT_ALLOWED', 405);
    if (!await userListAllowed(env, auth.user.id)) return apiError('RATE_LIMIT_EXCEEDED', 429);
    return listUserComments(url, env, auth.user);
  }

  if (url.pathname === '/api/user/recovery-code') {
    if (request.method === 'GET') return recoveryCodeStatus(env, auth.user.id);
    if (request.method === 'POST') return regenerateRecoveryCode(request, env, auth.user);
    return apiError('METHOD_NOT_ALLOWED', 405);
  }

  if (url.pathname === '/api/user/logout-all') {
    if (request.method !== 'POST') return apiError('METHOD_NOT_ALLOWED', 405);
    return logoutAllSessions(request, env, auth.user.id);
  }

  const pollMatch = url.pathname.match(/^\/api\/user\/polls\/(\d+)(?:\/(close))?$/);
  if (pollMatch) {
    const pollId = Number(pollMatch[1]);
    if (!Number.isSafeInteger(pollId) || pollId < 1) return apiError('INVALID_POLL_ID', 400);
    if (pollMatch[2] === 'close') {
      if (request.method !== 'POST') return apiError('METHOD_NOT_ALLOWED', 405);
      return closeUserPoll(env, auth.user, pollId);
    }
    if (request.method !== 'DELETE') return apiError('METHOD_NOT_ALLOWED', 405);
    return deleteUserPoll(env, auth.user, pollId);
  }

  const commentMatch = url.pathname.match(/^\/api\/user\/comments\/([A-Za-z0-9_-]+)$/);
  if (commentMatch) {
    if (request.method !== 'DELETE') return apiError('METHOD_NOT_ALLOWED', 405);
    return deleteUserComment(env, auth.user, commentMatch[1]);
  }

  return apiError('RESOURCE_NOT_FOUND', 404);
}

// Parses the optional positive `page` query parameter. A missing or empty value is
// page 1; anything else that is not a positive integer is invalid.
function parsePage(url: URL): number | null {
  const raw = url.searchParams.get('page');
  if (raw === null || raw === '') return 1;
  if (!/^\d+$/.test(raw)) return null;
  const page = Number(raw);
  return Number.isSafeInteger(page) && page >= 1 ? page : null;
}

interface OwnedPollRow {
  id: number;
  number: number | null;
  title: string | null;
  description: string | null;
  mode: number;
  status: number;
  start_at: number | null;
  end_at: number | null;
  created_at: number;
}

// Returns the poll row when the signed-in account's author mark matches, otherwise
// null.
async function findOwnedPoll(env: UserEnv, authorMark: string, pollId: number): Promise<OwnedPollRow | null> {
  return await env.DB.prepare(
    `SELECT id, number, title, description, mode, status, start_at, end_at, created_at
     FROM polls WHERE id = ? AND author_mark = ?`
  ).bind(pollId, authorMark).first<OwnedPollRow>();
}

// Lists the signed-in account's polls, newest first, one page at a time. One extra
// row is requested to detect whether a further page exists.
async function listUserPolls(url: URL, env: UserEnv, user: UserActor): Promise<Response> {
  const page = parsePage(url);
  if (page === null) return apiError('INVALID_PAGE', 400);

  const offset = (page - 1) * PAGE_SIZE;
  const result = await env.DB.prepare(
    `SELECT id, number, title, description, mode, status, start_at, end_at, created_at
     FROM polls WHERE author_mark = ?
     ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
  ).bind(user.authorMark, PAGE_SIZE + 1, offset).all<OwnedPollRow>();

  const rows = result.results ?? [];
  const hasMore = rows.length > PAGE_SIZE;
  const polls = rows.slice(0, PAGE_SIZE).map((row) => ({
    id: Number(row.id),
    number: row.number === null ? null : Number(row.number),
    title: row.title,
    description: row.description,
    mode: pollModeLabel(Number(row.mode)),
    status: pollStatusLabel(Number(row.status)),
    startAt: toIso(row.start_at),
    endAt: toIso(row.end_at),
    createdAt: toIso(row.created_at)
  }));

  return noStoreJson({ polls, page, hasMore });
}

async function closeUserPoll(env: UserEnv, user: UserActor, pollId: number): Promise<Response> {
  const poll = await findOwnedPoll(env, user.authorMark, pollId);
  if (!poll) return apiError('POLL_NOT_FOUND', 404);

  await env.DB.prepare(
    `UPDATE polls SET status = 2, closed_at = unixepoch(), updated_at = unixepoch()
     WHERE id = ? AND author_mark = ?`
  ).bind(pollId, user.authorMark).run();

  // Capture the terminal snapshot in the closing hour so the published chain
  // ends on the poll's final counts even when the hourly run has already passed.
  await writeSnapshotForPoll(env, pollId, currentHour(), true);

  return noStoreJson({ ok: true, pollId, status: 'closed' });
}

async function deleteUserPoll(env: UserEnv, user: UserActor, pollId: number): Promise<Response> {
  const poll = await findOwnedPoll(env, user.authorMark, pollId);
  if (!poll) return apiError('POLL_NOT_FOUND', 404);
  // Only polls that have not been reviewed yet can be withdrawn.
  if (Number(poll.status) !== 4) {
    return apiError('POLL_NOT_WITHDRAWABLE', 409);
  }

  // votes and comments cascade with the poll (ON DELETE CASCADE).
  await env.DB.prepare('DELETE FROM polls WHERE id = ? AND author_mark = ?')
    .bind(pollId, user.authorMark).run();
  return noStoreJson({ ok: true, pollId, deleted: true });
}

// Reports whether the account currently has an active recovery code.
async function recoveryCodeStatus(env: UserEnv, userId: number): Promise<Response> {
  const row = await env.DB.prepare(
    'SELECT recovery_code_hash IS NOT NULL AS configured FROM users WHERE id = ?'
  ).bind(userId).first<{ configured: number }>();
  return noStoreJson({ configured: Number(row?.configured ?? 0) === 1 });
}

// Lists the signed-in account's comments, newest first, one page at a time. One
// extra row is requested to detect whether a further page exists.
async function listUserComments(url: URL, env: UserEnv, user: UserActor): Promise<Response> {
  const page = parsePage(url);
  if (page === null) return apiError('INVALID_PAGE', 400);

  const offset = (page - 1) * PAGE_SIZE;
  const result = await env.DB.prepare(
    `SELECT c.public_id, c.poll_id, c.comment, c.created_at, p.title, p.number AS poll_number
     FROM comments c
     JOIN polls p ON p.id = c.poll_id
     WHERE c.author_mark = ?
     ORDER BY c.created_at DESC, c.public_id DESC LIMIT ? OFFSET ?`
  ).bind(user.authorMark, PAGE_SIZE + 1, offset).all<{
    public_id: string;
    poll_id: number;
    comment: string;
    created_at: number;
    title: string | null;
    poll_number: number | null;
  }>();

  const rows = result.results ?? [];
  const hasMore = rows.length > PAGE_SIZE;
  const comments = rows.slice(0, PAGE_SIZE).map((row) => ({
    id: row.public_id,
    pollId: Number(row.poll_id),
    pollNumber: row.poll_number === null ? null : Number(row.poll_number),
    pollTitle: row.title,
    comment: row.comment,
    createdAt: toIso(Number(row.created_at))
  }));

  return noStoreJson({ comments, page, hasMore });
}

// Deletes one of the account's own comments. The author mark is compared again, so
// a comment id from another account is a 404 rather than a deletion.
async function deleteUserComment(env: UserEnv, user: UserActor, publicId: string): Promise<Response> {
  if (!/^[0-9a-f]{16}$/i.test(publicId)) return apiError('INVALID_COMMENT_ID', 400);
  const id = publicId.toLowerCase();
  const result = await env.DB.prepare('DELETE FROM comments WHERE public_id = ? AND author_mark = ?')
    .bind(id, user.authorMark).run();
  if (Number(result.meta.changes ?? 0) !== 1) return apiError('COMMENT_NOT_FOUND', 404);
  return noStoreJson({ ok: true, id, deleted: true });
}

// Confirms the account's current password by re-deriving the verifier from the
// stored salt and iteration count. Used before destructive account actions.
async function confirmPassword(env: UserEnv, userId: number, password: string): Promise<boolean> {
  const user = await env.DB.prepare(
    'SELECT username, password_hash FROM users WHERE id = ?'
  ).bind(userId).first<{ username: string; password_hash: string }>();
  if (!user) return false;
  const parsed = parseUserPasswordHash(user.password_hash);
  if (!parsed) return false;
  const material = await derivePasswordMaterialRemote(env, user.username, password, parsed.saltHex, parsed.iterations);
  return constantTimeEqual(material.verifierHex, parsed.verifierHex);
}

// Replaces the recovery code and returns the new plaintext code once. The
// current password must be supplied so a hijacked session cannot lock the real
// owner out of recovery. The author key is re-wrapped under the new code's wrap
// key in the same update.
async function regenerateRecoveryCode(request: Request, env: UserEnv, user: UserActor): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError('INVALID_JSON', 400);
  }
  const currentPassword = typeof body === 'object' && body !== null
    ? String((body as Record<string, unknown>).currentPassword ?? '')
    : '';
  if (!currentPassword) {
    return apiError('CURRENT_PASSWORD_REQUIRED', 400);
  }

  if (!await confirmPassword(env, user.id, currentPassword)) {
    return apiError('CURRENT_PASSWORD_INCORRECT', 403);
  }

  const recoveryCode = await generateRecoveryCode();
  const authorKeyRc = await wrapHex(
    await recoveryWrapKeyHex(normalizeRecoveryCode(recoveryCode.code)),
    user.authorKeyHex
  );
  await env.DB.prepare(
    `UPDATE users SET recovery_code_hash = ?, author_key_rc = ?, recovery_code_updated_at = unixepoch(),
       updated_at = unixepoch() WHERE id = ?`
  ).bind(recoveryCode.hash, authorKeyRc, user.id).run();
  return noStoreJson({ ok: true, recoveryCode: recoveryCode.code });
}

// Signs every device out of the account. The cookie of the requesting browser is
// cleared as well, so the browser that revoked the sessions is signed out too.
async function logoutAllSessions(request: Request, env: UserEnv, userId: number): Promise<Response> {
  await env.DB.prepare('DELETE FROM user_sessions WHERE user_id = ?').bind(userId).run();
  return noStoreJson({ ok: true, revoked: true }, 200, {
    'set-cookie': buildClearSessionCookie(isSecureRequest(request))
  });
}

// Deletes the account after confirming the password. Sessions are revoked and
// the account row is removed. Submitted polls and comments keep their author
// mark, which no longer corresponds to any account, so they stay public and
// permanently anonymous.
async function deleteAccount(request: Request, env: UserEnv, user: UserActor): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError('INVALID_JSON', 400);
  }
  const currentPassword = typeof body === 'object' && body !== null
    ? String((body as Record<string, unknown>).currentPassword ?? '')
    : '';
  if (!currentPassword) {
    return apiError('CURRENT_PASSWORD_REQUIRED', 400);
  }

  if (!await confirmPassword(env, user.id, currentPassword)) {
    return apiError('CURRENT_PASSWORD_INCORRECT', 403);
  }

  await env.DB.batch([
    env.DB.prepare('DELETE FROM user_sessions WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id)
  ]);

  return noStoreJson({ ok: true, deleted: true });
}

function toIso(unixSeconds: number | null): string | null {
  return unixSeconds === null ? null : new Date(unixSeconds * 1000).toISOString();
}