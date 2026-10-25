// Public user account management: list, disable/enable, unlock, and delete.
//
// These accounts belong to the public application (the `users` table). They sign
// up with a username and password only and have no recovery channel, so the
// dashboard deliberately offers no password reset. Disabling or deleting a user
// revokes their sessions; deleting keeps their polls and comments, which keep an
// author mark that no longer corresponds to any account.

import type { AdminActor, AdminEnv } from '../auth';
import { logAudit } from '../lib/audit';
import { noStoreJson, readJsonBody, readString } from '../../shared/http';
import { USER_STATUS_ACTIVE, USER_STATUS_DISABLED, userStatusCode, userStatusLabel } from '../../worker/services/users';

const MAX_PAGE_SIZE = 100;
const MAX_QUERY_LENGTH = 100;
const USER_STATUS_FILTERS = ['all', 'active', 'disabled', 'locked'];

interface UserRow {
  id: number;
  username: string;
  status: number;
  failed_attempts: number;
  locked_until: number | null;
  last_login_at: number | null;
  created_at: number;
  updated_at: number;
}

export async function handleUsersRequest(
  request: Request,
  url: URL,
  env: AdminEnv,
  actor: AdminActor
): Promise<Response> {
  const match = url.pathname.match(/^\/api\/admin\/users(?:\/(\d+)(?:\/(status|unlock))?)?$/);
  if (!match) return noStoreJson({ message: 'not found' }, 404);

  const [, idText, action] = match;

  if (!idText) {
    if (request.method !== 'GET') return noStoreJson({ message: 'method not allowed' }, 405);
    return listUsers(url, env);
  }

  const userId = Number(idText);
  if (!Number.isSafeInteger(userId) || userId < 1) {
    return noStoreJson({ message: 'invalid user ID' }, 400);
  }

  if (!action && request.method === 'DELETE') {
    return deleteUser(userId, env, actor);
  }
  if (request.method !== 'POST') {
    return noStoreJson({ message: 'method not allowed' }, 405);
  }
  if (action === 'unlock') return unlockUser(userId, env, actor);
  if (action === 'status') return updateUserStatus(userId, request, env, actor);
  return noStoreJson({ message: 'not found' }, 404);
}

async function listUsers(url: URL, env: AdminEnv): Promise<Response> {
  const page = Number(url.searchParams.get('page') ?? '1');
  const pageSize = Number(url.searchParams.get('pageSize') ?? '25');
  if (!Number.isSafeInteger(page) || page < 1
    || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    return noStoreJson({ message: 'invalid pagination parameters' }, 400);
  }

  const statusParam = (url.searchParams.get('status') ?? 'all').trim().toLowerCase();
  if (!USER_STATUS_FILTERS.includes(statusParam)) {
    return noStoreJson({ message: 'invalid status filter' }, 400);
  }

  const query = (url.searchParams.get('q') ?? '').trim().slice(0, MAX_QUERY_LENGTH);
  const likePattern = query ? `%${query.replace(/[\\%_]/g, (character) => `\\${character}`)}%` : '';

  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (statusParam === 'active') {
    clauses.push('u.status = ?');
    binds.push(USER_STATUS_ACTIVE);
  } else if (statusParam === 'disabled') {
    clauses.push('u.status = ?');
    binds.push(USER_STATUS_DISABLED);
  } else if (statusParam === 'locked') {
    clauses.push('u.locked_until IS NOT NULL AND u.locked_until > ?');
    binds.push(Math.floor(Date.now() / 1000));
  }
  if (query) {
    clauses.push("u.username LIKE ? ESCAPE '\\'");
    binds.push(likePattern);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const countResult = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM users u ${where}`
  ).bind(...binds).first<{ total: number }>();

  const total = Number(countResult?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages);
  const offset = (currentPage - 1) * pageSize;

  const result = await env.DB.prepare(
    `SELECT u.id, u.username, u.status, u.failed_attempts, u.locked_until, u.last_login_at,
            u.created_at, u.updated_at
     FROM users u
     ${where}
     ORDER BY u.created_at DESC, u.id DESC
     LIMIT ? OFFSET ?`
  ).bind(...binds, pageSize, offset).all<UserRow>();

  return noStoreJson({
    users: (result.results ?? []).map(serializeUser),
    page: currentPage,
    pageSize,
    total,
    totalPages,
    status: statusParam,
    query
  });
}

async function findUser(env: AdminEnv, userId: number): Promise<{ id: number; username: string; status: number } | null> {
  return env.DB.prepare(
    'SELECT id, username, status FROM users WHERE id = ?'
  ).bind(userId).first<{ id: number; username: string; status: number }>();
}

async function updateUserStatus(
  userId: number,
  request: Request,
  env: AdminEnv,
  actor: AdminActor
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body) return noStoreJson({ message: 'invalid JSON' }, 400);

  const statusValue = userStatusCode(readString(body, 'status'));
  if (statusValue === null) {
    return noStoreJson({ message: 'status must be "active" or "disabled"' }, 422);
  }

  const user = await findUser(env, userId);
  if (!user) return noStoreJson({ message: `user ${userId} was not found` }, 404);

  if (statusValue === user.status) {
    return noStoreJson({ ok: true, message: `User ${user.username} is already ${userStatusLabel(statusValue)}.` });
  }

  await env.DB.prepare(
    'UPDATE users SET status = ?, updated_at = unixepoch() WHERE id = ?'
  ).bind(statusValue, userId).run();

  // A disabled account must not keep any active session.
  if (statusValue !== USER_STATUS_ACTIVE) {
    await env.DB.prepare('DELETE FROM user_sessions WHERE user_id = ?').bind(userId).run();
  }

  await logAudit(env, {
    actor, action: 'user.status', targetType: 'user', targetId: userId,
    details: { username: user.username, status: userStatusLabel(statusValue) }
  });

  return noStoreJson({ ok: true, message: `User ${user.username} is now ${userStatusLabel(statusValue)}.` });
}

async function unlockUser(userId: number, env: AdminEnv, actor: AdminActor): Promise<Response> {
  const user = await findUser(env, userId);
  if (!user) return noStoreJson({ message: `user ${userId} was not found` }, 404);

  await env.DB.prepare(
    'UPDATE users SET failed_attempts = 0, locked_until = NULL, updated_at = unixepoch() WHERE id = ?'
  ).bind(userId).run();

  await logAudit(env, {
    actor, action: 'user.unlock', targetType: 'user', targetId: userId,
    details: { username: user.username }
  });

  return noStoreJson({ ok: true, message: `Cleared the lock and failed attempts for ${user.username}.` });
}

async function deleteUser(userId: number, env: AdminEnv, actor: AdminActor): Promise<Response> {
  const user = await findUser(env, userId);
  if (!user) return noStoreJson({ message: `user ${userId} was not found` }, 404);

  // Sessions cascade with the account row. Submitted polls and comments stay
  // public; they keep an author mark that no longer corresponds to any account.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM user_sessions WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId)
  ]);

  await logAudit(env, {
    actor, action: 'user.delete', targetType: 'user', targetId: userId,
    details: { username: user.username }
  });

  return noStoreJson({
    ok: true,
    message: `Deleted ${user.username}. Their polls and comments were kept; their author mark no longer corresponds to any account.`
  });
}

function serializeUser(row: UserRow) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: row.id,
    username: row.username,
    status: userStatusLabel(row.status),
    failedAttempts: Number(row.failed_attempts),
    lockedUntil: row.locked_until ? new Date(row.locked_until * 1000).toISOString() : null,
    isLocked: row.locked_until !== null && row.locked_until > now,
    lastLoginAt: row.last_login_at ? new Date(row.last_login_at * 1000).toISOString() : null,
    createdAt: new Date(row.created_at * 1000).toISOString(),
    updatedAt: new Date(row.updated_at * 1000).toISOString()
  };
}
