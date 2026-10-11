// Self-service endpoints for the signed-in account: list and manage the polls
// and comments that belong to it.

import type { HandlerEnv } from '../index';
import { requireUser } from '../services/session';
import { enforceSameOrigin } from '../services/csrf';
import { verifyPassword } from '../services/password';
import { generateRecoveryCode } from '../services/recovery';

const MAX_PAGE_SIZE = 100;

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

function noStoreJson(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { 'cache-control': 'no-store' }
  });
}

export async function handleUserRequest(request: Request, url: URL, env: UserEnv): Promise<Response> {
  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;

  // Every cookie-authenticated mutation must come from the site itself.
  const csrf = enforceSameOrigin(request, { viaCookie: true });
  if (csrf) return csrf;

  if (url.pathname === '/api/user/account') {
    if (request.method !== 'DELETE') return noStoreJson({ message: 'method not allowed' }, 405);
    return deleteAccount(request, env, auth.user.id);
  }

  if (url.pathname === '/api/user/polls') {
    if (request.method !== 'GET') return noStoreJson({ message: 'method not allowed' }, 405);
    return listUserPolls(url, env, auth.user.id);
  }

  if (url.pathname === '/api/user/comments') {
    if (request.method !== 'GET') return noStoreJson({ message: 'method not allowed' }, 405);
    return listUserComments(url, env, auth.user.id);
  }

  if (url.pathname === '/api/user/recovery-code') {
    if (request.method === 'GET') return recoveryCodeStatus(env, auth.user.id);
    if (request.method === 'POST') return regenerateRecoveryCode(request, env, auth.user.id);
    return noStoreJson({ message: 'method not allowed' }, 405);
  }

  const pollMatch = url.pathname.match(/^\/api\/user\/polls\/(\d+)(?:\/(close))?$/);
  if (pollMatch) {
    const pollId = Number(pollMatch[1]);
    if (!Number.isSafeInteger(pollId) || pollId < 1) return noStoreJson({ message: 'invalid poll ID' }, 400);
    if (pollMatch[2] === 'close') {
      if (request.method !== 'POST') return noStoreJson({ message: 'method not allowed' }, 405);
      return closeUserPoll(env, auth.user.id, pollId);
    }
    if (request.method !== 'DELETE') return noStoreJson({ message: 'method not allowed' }, 405);
    return deleteUserPoll(env, auth.user.id, pollId);
  }

  const commentMatch = url.pathname.match(/^\/api\/user\/comments\/(\d+)$/);
  if (commentMatch) {
    const commentId = Number(commentMatch[1]);
    if (!Number.isSafeInteger(commentId) || commentId < 1) return noStoreJson({ message: 'invalid comment ID' }, 400);
    if (request.method !== 'DELETE') return noStoreJson({ message: 'method not allowed' }, 405);
    return deleteUserComment(env, auth.user.id, commentId);
  }

  return noStoreJson({ message: 'not found' }, 404);
}

function parsePagination(url: URL): { page: number; pageSize: number } | null {
  const page = Number(url.searchParams.get('page') ?? '1');
  const pageSize = Number(url.searchParams.get('pageSize') ?? '20');
  if (!Number.isSafeInteger(page) || page < 1
    || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    return null;
  }
  return { page, pageSize };
}

async function listUserPolls(url: URL, env: UserEnv, userId: number): Promise<Response> {
  const pagination = parsePagination(url);
  if (!pagination) return noStoreJson({ message: 'invalid pagination parameters' }, 400);
  const { page, pageSize } = pagination;

  const countRow = await env.DB.prepare(
    'SELECT COUNT(*) AS total FROM polls WHERE user_id = ?'
  ).bind(userId).first<{ total: number }>();
  const total = Number(countRow?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages);
  const offset = (currentPage - 1) * pageSize;

  const result = await env.DB.prepare(
    `SELECT id, title, description, mode, status, start_at, end_at, created_at
     FROM polls WHERE user_id = ?
     ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
  ).bind(userId, pageSize, offset).all<{
    id: number;
    title: string | null;
    description: string | null;
    mode: number;
    status: number;
    start_at: number | null;
    end_at: number | null;
    created_at: number;
  }>();

  return noStoreJson({
    polls: (result.results ?? []).map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      mode: pollModeLabel(row.mode),
      status: pollStatusLabel(row.status),
      startAt: toIso(row.start_at),
      endAt: toIso(row.end_at),
      createdAt: toIso(row.created_at)
    })),
    page: currentPage,
    pageSize,
    total,
    totalPages
  });
}

async function listUserComments(url: URL, env: UserEnv, userId: number): Promise<Response> {
  const pagination = parsePagination(url);
  if (!pagination) return noStoreJson({ message: 'invalid pagination parameters' }, 400);
  const { page, pageSize } = pagination;

  const countRow = await env.DB.prepare(
    'SELECT COUNT(*) AS total FROM comments WHERE user_id = ?'
  ).bind(userId).first<{ total: number }>();
  const total = Number(countRow?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages);
  const offset = (currentPage - 1) * pageSize;

  const result = await env.DB.prepare(
    `SELECT c.id, c.poll_id, c.comment, c.created_at, i.title AS poll_title
     FROM comments c
     LEFT JOIN polls i ON i.id = c.poll_id
     WHERE c.user_id = ?
     ORDER BY c.created_at DESC, c.id DESC LIMIT ? OFFSET ?`
  ).bind(userId, pageSize, offset).all<{
    id: number;
    poll_id: number;
    comment: string;
    created_at: number;
    poll_title: string | null;
  }>();

  return noStoreJson({
    comments: (result.results ?? []).map((row) => ({
      id: row.id,
      pollId: row.poll_id,
      pollTitle: row.poll_title,
      comment: row.comment,
      createdAt: toIso(row.created_at)
    })),
    page: currentPage,
    pageSize,
    total,
    totalPages
  });
}

async function closeUserPoll(env: UserEnv, userId: number, pollId: number): Promise<Response> {
  const poll = await env.DB.prepare(
    'SELECT id, status FROM polls WHERE id = ? AND user_id = ?'
  ).bind(pollId, userId).first<{ id: number; status: number }>();
  if (!poll) return noStoreJson({ message: 'poll not found' }, 404);

  await env.DB.prepare(
    'UPDATE polls SET status = 2, updated_at = unixepoch() WHERE id = ? AND user_id = ?'
  ).bind(pollId, userId).run();
  return noStoreJson({ ok: true, pollId, status: 'closed' });
}

async function deleteUserPoll(env: UserEnv, userId: number, pollId: number): Promise<Response> {
  const poll = await env.DB.prepare(
    'SELECT id, status FROM polls WHERE id = ? AND user_id = ?'
  ).bind(pollId, userId).first<{ id: number; status: number }>();
  if (!poll) return noStoreJson({ message: 'poll not found' }, 404);
  // Only polls that have not been reviewed yet can be withdrawn.
  if (poll.status !== 4) {
    return noStoreJson({ message: 'only polls still under review can be withdrawn' }, 409);
  }

  await env.DB.batch([
    env.DB.prepare('DELETE FROM votes WHERE poll_id = ?').bind(pollId),
    env.DB.prepare('DELETE FROM comments WHERE poll_id = ?').bind(pollId),
    env.DB.prepare('DELETE FROM polls WHERE id = ? AND user_id = ?').bind(pollId, userId)
  ]);
  return noStoreJson({ ok: true, pollId, deleted: true });
}

async function deleteUserComment(env: UserEnv, userId: number, commentId: number): Promise<Response> {
  const comment = await env.DB.prepare(
    'SELECT id FROM comments WHERE id = ? AND user_id = ?'
  ).bind(commentId, userId).first<{ id: number }>();
  if (!comment) return noStoreJson({ message: 'comment not found' }, 404);

  await env.DB.prepare('DELETE FROM comments WHERE id = ? AND user_id = ?').bind(commentId, userId).run();
  return noStoreJson({ ok: true, commentId, deleted: true });
}

// Reports whether the account currently has an active recovery code.
async function recoveryCodeStatus(env: UserEnv, userId: number): Promise<Response> {
  const row = await env.DB.prepare(
    'SELECT recovery_code_hash IS NOT NULL AS configured FROM users WHERE id = ?'
  ).bind(userId).first<{ configured: number }>();
  return noStoreJson({ configured: Number(row?.configured ?? 0) === 1 });
}

// Replaces the recovery code and returns the new plaintext code once. The
// current password must be supplied so a hijacked session cannot lock the real
// owner out of recovery.
async function regenerateRecoveryCode(request: Request, env: UserEnv, userId: number): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStoreJson({ message: 'invalid JSON' }, 400);
  }
  const currentPassword = typeof body === 'object' && body !== null
    ? String((body as Record<string, unknown>).currentPassword ?? '')
    : '';
  if (!currentPassword) {
    return noStoreJson({ message: 'current password is required' }, 400);
  }

  const user = await env.DB.prepare(
    'SELECT password_hash FROM users WHERE id = ?'
  ).bind(userId).first<{ password_hash: string }>();
  if (!user || !await verifyPassword(currentPassword, user.password_hash)) {
    return noStoreJson({ message: 'current password is incorrect' }, 403);
  }

  const recoveryCode = await generateRecoveryCode();
  await env.DB.prepare(
    'UPDATE users SET recovery_code_hash = ?, recovery_code_updated_at = unixepoch(), updated_at = unixepoch() WHERE id = ?'
  ).bind(recoveryCode.hash, userId).run();
  return noStoreJson({ ok: true, recoveryCode: recoveryCode.code });
}

// Deletes the account after confirming the password. Sessions are revoked and
// the user's polls and comments are detached (user_id set to NULL) so the public
// content stays but is no longer linked to an account.
async function deleteAccount(request: Request, env: UserEnv, userId: number): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStoreJson({ message: 'invalid JSON' }, 400);
  }
  const currentPassword = typeof body === 'object' && body !== null
    ? String((body as Record<string, unknown>).currentPassword ?? '')
    : '';
  if (!currentPassword) {
    return noStoreJson({ message: 'current password is required' }, 400);
  }

  const user = await env.DB.prepare(
    'SELECT password_hash FROM users WHERE id = ?'
  ).bind(userId).first<{ password_hash: string }>();
  if (!user || !await verifyPassword(currentPassword, user.password_hash)) {
    return noStoreJson({ message: 'current password is incorrect' }, 403);
  }

  await env.DB.batch([
    env.DB.prepare('DELETE FROM user_sessions WHERE user_id = ?').bind(userId),
    env.DB.prepare('UPDATE polls SET user_id = NULL WHERE user_id = ?').bind(userId),
    env.DB.prepare('UPDATE comments SET user_id = NULL WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId)
  ]);

  return noStoreJson({ ok: true, deleted: true });
}

function toIso(unixSeconds: number | null): string | null {
  return unixSeconds === null ? null : new Date(unixSeconds * 1000).toISOString();
}
