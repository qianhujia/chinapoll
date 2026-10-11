// Self-service endpoints for the signed-in account.
//
// Poll ownership is stored as a one-way owner hash (see worker/services/owner.ts),
// so "my polls" is answered only for the poll ids the client remembers and only
// for rows whose owner hash matches. Comments carry no owner, so there is no
// comment list or comment deletion endpoint here.

import type { HandlerEnv } from '../index';
import { requireUser } from '../services/session';
import { enforceSameOrigin } from '../services/csrf';
import { verifyPassword } from '../../shared/password';
import { generateRecoveryCode } from '../services/recovery';
import { ownerHash } from '../services/owner';

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

  return noStoreJson({ message: 'not found' }, 404);
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
  const expected = await ownerHash(userId, pollId, env.IP_HASH_KEY);
  if (!expected || expected !== row.owner_hash) return null;
  return row;
}
// Lists the requested poll ids that the signed-in account actually owns. The
// client supplies the ids it remembers from submission, so the server never has
// to scan all polls.
async function listUserPolls(url: URL, env: UserEnv, userId: number): Promise<Response> {
  const ids = parseIds(url);
  if (!ids) return noStoreJson({ message: 'invalid ids parameter' }, 400);
  if (ids.length === 0) return noStoreJson({ polls: [] });

  const placeholders = ids.map(() => '?').join(', ');
  const result = await env.DB.prepare(
    `SELECT id, title, description, mode, status, start_at, end_at, owner_hash, created_at
     FROM polls WHERE id IN (${placeholders})`
  ).bind(...ids).all<OwnedPollRow>();

  const polls = [];
  for (const row of result.results ?? []) {
    const expected = await ownerHash(userId, Number(row.id), env.IP_HASH_KEY);
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
  if (!poll) return noStoreJson({ message: 'poll not found' }, 404);

  await env.DB.prepare(
    `UPDATE polls SET status = 2, closed_at = unixepoch(), updated_at = unixepoch()
     WHERE id = ? AND owner_hash = ?`
  ).bind(pollId, poll.owner_hash).run();
  return noStoreJson({ ok: true, pollId, status: 'closed' });
}

async function deleteUserPoll(env: UserEnv, userId: number, pollId: number): Promise<Response> {
  const poll = await findOwnedPoll(env, userId, pollId);
  if (!poll) return noStoreJson({ message: 'poll not found' }, 404);
  // Only polls that have not been reviewed yet can be withdrawn.
  if (Number(poll.status) !== 4) {
    return noStoreJson({ message: 'only polls still under review can be withdrawn' }, 409);
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
// the account row is removed. Submitted polls and comments stay public but carry
// no account link (poll ownership is a one-way hash).
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
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId)
  ]);

  return noStoreJson({ ok: true, deleted: true });
}

function toIso(unixSeconds: number | null): string | null {
  return unixSeconds === null ? null : new Date(unixSeconds * 1000).toISOString();
}