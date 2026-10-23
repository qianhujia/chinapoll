// Self-service endpoints for the signed-in account.
//
// Ownership is stored as a one-way owner hash (see worker/services/owner.ts), so
// "my polls" is answered only for the poll ids the client remembers and "my
// comments" only for the comment public ids it remembers, and only for rows whose
// owner hash matches. Comments gain no public author link: the hash is never
// published, and a comment created before the hash existed simply cannot be claimed.

import type { HandlerEnv } from '../index';
import { buildClearSessionCookie, isSecureRequest, requireUser } from '../services/session';
import { enforceSameOrigin } from '../services/csrf';
import { verifyPassword } from '../services/passwordHasher';
import { generateRecoveryCode } from '../services/recovery';
import { commentOwnerHash, ownerHash } from '../services/owner';
import { serverHmacKey } from '../services/ip';
import { currentHour, writeSnapshotForPoll } from '../services/maintenance';
import { apiError } from '../../shared/http';

const MAX_IDS = 100;

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

export async function handleUserRequest(request: Request, url: URL, env: UserEnv): Promise<Response> {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;

  // Every cookie-authenticated mutation must come from the site itself.
  const csrf = enforceSameOrigin(request, { viaCookie: true });
  if (csrf) return csrf;

  if (url.pathname === '/api/user/account') {
    if (request.method !== 'DELETE') return apiError('METHOD_NOT_ALLOWED', 405);
    return deleteAccount(request, env, auth.user.id);
  }

  if (url.pathname === '/api/user/polls') {
    if (request.method !== 'GET') return apiError('METHOD_NOT_ALLOWED', 405);
    return listUserPolls(url, env, auth.user.id);
  }

  if (url.pathname === '/api/user/comments') {
    if (request.method !== 'GET') return apiError('METHOD_NOT_ALLOWED', 405);
    return listUserComments(url, env, auth.user.id);
  }

  if (url.pathname === '/api/user/recovery-code') {
    if (request.method === 'GET') return recoveryCodeStatus(env, auth.user.id);
    if (request.method === 'POST') return regenerateRecoveryCode(request, env, auth.user.id);
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
      return closeUserPoll(env, auth.user.id, pollId);
    }
    if (request.method !== 'DELETE') return apiError('METHOD_NOT_ALLOWED', 405);
    return deleteUserPoll(env, auth.user.id, pollId);
  }

  const commentMatch = url.pathname.match(/^\/api\/user\/comments\/([A-Za-z0-9_-]+)$/);
  if (commentMatch) {
    if (request.method !== 'DELETE') return apiError('METHOD_NOT_ALLOWED', 405);
    return deleteUserComment(env, auth.user.id, commentMatch[1]);
  }

  return apiError('RESOURCE_NOT_FOUND', 404);
}

// Parses the comma-separated `ids` query parameter used by the client-side list.
function parseIds(url: URL): number[] | null {
  const raw = (url.searchParams.get('ids') ?? '').trim();
  if (!raw) return [];
  const ids: number[] = [];
  for (const part of raw.split(',').slice(0, MAX_IDS)) {
    const value = Number(part);
    if (!Number.isSafeInteger(value) || value < 1) return null;
    ids.push(value);
  }
  return ids;
}

interface OwnedPollRow {
  id: number;
  title: string | null;
  description: string | null;
  mode: number;
  status: number;
  start_at: number | null;
  end_at: number | null;
  owner_hash: string | null;
  created_at: number;
}

// Returns the poll row when the recomputed owner hash matches, otherwise null.
async function findOwnedPoll(env: UserEnv, userId: number, pollId: number): Promise<OwnedPollRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, title, description, mode, status, start_at, end_at, owner_hash, created_at
     FROM polls WHERE id = ?`
  ).bind(pollId).first<OwnedPollRow>();
  if (!row) return null;
  const expected = await ownerHash(userId, pollId, serverHmacKey(env));
  if (!expected || expected !== row.owner_hash) return null;
  return row;
}
// Lists the requested poll ids that the signed-in account actually owns. The
// client supplies the ids it remembers from submission, so the server never has
// to scan all polls.
async function listUserPolls(url: URL, env: UserEnv, userId: number): Promise<Response> {
  const ids = parseIds(url);
  if (!ids) return apiError('INVALID_IDS', 400);
  if (ids.length === 0) return noStoreJson({ polls: [] });

  const placeholders = ids.map(() => '?').join(', ');
  const result = await env.DB.prepare(
    `SELECT id, title, description, mode, status, start_at, end_at, owner_hash, created_at
     FROM polls WHERE id IN (${placeholders})`
  ).bind(...ids).all<OwnedPollRow>();

  const polls = [];
  for (const row of result.results ?? []) {
    const expected = await ownerHash(userId, Number(row.id), serverHmacKey(env));
    if (!expected || expected !== row.owner_hash) continue;
    polls.push({
      id: Number(row.id),
      title: row.title,
      description: row.description,
      mode: pollModeLabel(Number(row.mode)),
      status: pollStatusLabel(Number(row.status)),
      startAt: toIso(row.start_at),
      endAt: toIso(row.end_at),
      createdAt: toIso(row.created_at)
    });
  }

  return noStoreJson({ polls });
}

async function closeUserPoll(env: UserEnv, userId: number, pollId: number): Promise<Response> {
  const poll = await findOwnedPoll(env, userId, pollId);
  if (!poll) return apiError('POLL_NOT_FOUND', 404);

  await env.DB.prepare(
    `UPDATE polls SET status = 2, closed_at = unixepoch(), updated_at = unixepoch()
     WHERE id = ? AND owner_hash = ?`
  ).bind(pollId, poll.owner_hash).run();

  // Capture the terminal snapshot in the closing hour so the published chain
  // ends on the poll's final counts even when the hourly run has already passed.
  await writeSnapshotForPoll(env, pollId, currentHour(), true);

  return noStoreJson({ ok: true, pollId, status: 'closed' });
}

async function deleteUserPoll(env: UserEnv, userId: number, pollId: number): Promise<Response> {
  const poll = await findOwnedPoll(env, userId, pollId);
  if (!poll) return apiError('POLL_NOT_FOUND', 404);
  // Only polls that have not been reviewed yet can be withdrawn.
  if (Number(poll.status) !== 4) {
    return apiError('POLL_NOT_WITHDRAWABLE', 409);
  }

  // votes and comments cascade with the poll (ON DELETE CASCADE).
  await env.DB.prepare('DELETE FROM polls WHERE id = ? AND owner_hash = ?')
    .bind(pollId, poll.owner_hash).run();
  return noStoreJson({ ok: true, pollId, deleted: true });
}

// Reports whether the account currently has an active recovery code.
async function recoveryCodeStatus(env: UserEnv, userId: number): Promise<Response> {
  const row = await env.DB.prepare(
    'SELECT recovery_code_hash IS NOT NULL AS configured FROM users WHERE id = ?'
  ).bind(userId).first<{ configured: number }>();
  return noStoreJson({ configured: Number(row?.configured ?? 0) === 1 });
}

// Parses the comma-separated `ids` query parameter of the comment list. The ids are
// the random public ids the client remembered when it posted each comment.
function parseCommentIds(url: URL): string[] | null {
  const raw = (url.searchParams.get('ids') ?? '').trim();
  if (!raw) return [];
  const ids: string[] = [];
  for (const part of raw.split(',').slice(0, MAX_IDS)) {
    const id = part.trim();
    if (!/^[0-9a-f]{16}$/i.test(id)) return null;
    ids.push(id.toLowerCase());
  }
  return ids;
}

// Returns the stored comment row of one account, or null when the row does not
// exist or its owner hash does not match.
async function findOwnedComment<T extends { owner_hash: string | null; public_id: string }>(
  env: UserEnv,
  userId: number,
  row: T | null
): Promise<T | null> {
  if (!row) return null;
  const expected = await commentOwnerHash(userId, row.public_id, serverHmacKey(env));
  if (!expected || expected !== row.owner_hash) return null;
  return row;
}

// Lists the comments of the requested public ids that the signed-in account
// actually posted. The client supplies the ids it remembers from posting, so the
// server never has to scan every comment, and the owner hash proves ownership.
async function listUserComments(url: URL, env: UserEnv, userId: number): Promise<Response> {
  const ids = parseCommentIds(url);
  if (!ids) return apiError('INVALID_IDS', 400);
  if (ids.length === 0) return noStoreJson({ comments: [] });

  const placeholders = ids.map(() => '?').join(', ');
  const result = await env.DB.prepare(
    `SELECT c.public_id, c.poll_id, c.comment, c.created_at, c.owner_hash, p.title
     FROM comments c
     JOIN polls p ON p.id = c.poll_id
     WHERE c.public_id IN (${placeholders})
     ORDER BY c.created_at DESC, c.public_id DESC`
  ).bind(...ids).all<{
    public_id: string;
    poll_id: number;
    comment: string;
    created_at: number;
    owner_hash: string | null;
    title: string | null;
  }>();

  const comments = [];
  for (const row of result.results ?? []) {
    if (!await findOwnedComment(env, userId, row)) continue;
    comments.push({
      id: row.public_id,
      pollId: Number(row.poll_id),
      pollTitle: row.title,
      comment: row.comment,
      createdAt: toIso(Number(row.created_at))
    });
  }
  // The order is fixed (newest hour first, then by public id) so a refresh does not
  // shuffle the list. Comments posted in the same hour share a coarsened timestamp,
  // so the client, which knows its own posting order, is what shows the newest first.
  return noStoreJson({ comments });
}

// Deletes one of the account's own comments. The owner hash is compared again, so
// a comment id from another account is a 404 rather than a deletion.
async function deleteUserComment(env: UserEnv, userId: number, publicId: string): Promise<Response> {
  if (!/^[0-9a-f]{16}$/i.test(publicId)) return apiError('INVALID_COMMENT_ID', 400);
  const row = await findOwnedComment(env, userId, await env.DB.prepare(
    'SELECT public_id, owner_hash FROM comments WHERE public_id = ?'
  ).bind(publicId).first<{ public_id: string; owner_hash: string | null }>());
  if (!row) return apiError('COMMENT_NOT_FOUND', 404);

  await env.DB.prepare('DELETE FROM comments WHERE public_id = ? AND owner_hash = ?')
    .bind(row.public_id, row.owner_hash).run();
  return noStoreJson({ ok: true, id: row.public_id, deleted: true });
}

// Replaces the recovery code and returns the new plaintext code once. The
// current password must be supplied so a hijacked session cannot lock the real
// owner out of recovery.
async function regenerateRecoveryCode(request: Request, env: UserEnv, userId: number): Promise<Response> {
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

  // The password hasher is sharded by username, so the username is read here.
  const user = await env.DB.prepare(
    'SELECT username, password_hash FROM users WHERE id = ?'
  ).bind(userId).first<{ username: string; password_hash: string }>();
  if (!user || !await verifyPassword(env, user.username, currentPassword, user.password_hash)) {
    return apiError('CURRENT_PASSWORD_INCORRECT', 403);
  }

  const recoveryCode = await generateRecoveryCode();
  await env.DB.prepare(
    'UPDATE users SET recovery_code_hash = ?, recovery_code_updated_at = unixepoch(), updated_at = unixepoch() WHERE id = ?'
  ).bind(recoveryCode.hash, userId).run();
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
// the account row is removed. Submitted polls and comments stay public but carry
// no account link (poll ownership is a one-way hash).
async function deleteAccount(request: Request, env: UserEnv, userId: number): Promise<Response> {
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

  // The password hasher is sharded by username, so the username is read here.
  const user = await env.DB.prepare(
    'SELECT username, password_hash FROM users WHERE id = ?'
  ).bind(userId).first<{ username: string; password_hash: string }>();
  if (!user || !await verifyPassword(env, user.username, currentPassword, user.password_hash)) {
    return apiError('CURRENT_PASSWORD_INCORRECT', 403);
  }

  await env.DB.batch([
    env.DB.prepare('DELETE FROM user_sessions WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId)
  ]);

  return noStoreJson({ ok: true, deleted: true });
}

function toIso(unixSeconds: number | null): string | null {
  return unixSeconds === null ? null : new Date(unixSeconds * 1000).toISOString();
}