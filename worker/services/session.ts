// Session handling for public user accounts.
//
// A successful sign-in creates a server-side session with a 30-day sliding
// expiry; the random session token is stored in an HttpOnly, SameSite=Strict
// cookie and only its SHA-256 hash is kept in the database. The row also keeps
// the account's author key wrapped under a session-token-derived key, so the
// signed-in session can recover the author key without the password.

import { buildCookie, readCookie } from '../../shared/cookies';
import { sha256Hex, toHex, unwrapHex, wrapHex } from '../../shared/crypto';
import { authorMark, sessionWrapKeyHex } from './author';
import { USER_STATUS_ACTIVE } from './users';
import { apiError } from '../../shared/http';

export const USER_SESSION_COOKIE = 'chinapoll_user_session';
export const USER_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
// Active sessions are extended at most about once per minute to limit writes.
const SLIDE_THRESHOLD_SECONDS = 60;

export interface UserActor {
  id: number;
  username: string;
  createdAt: number;
  // The account's author key and its author mark. These are internal to the
  // Worker and must never be serialized into an HTTP response; `publicUser()`
  // in worker/api/auth.ts picks the response fields explicitly.
  authorKeyHex: string;
  authorMark: string;
}

export interface SessionEnv {
  DB: D1Database;
}

export function buildSessionCookie(token: string, secure: boolean): string {
  return buildCookie(USER_SESSION_COOKIE, token, {
    secure,
    maxAge: USER_SESSION_TTL_SECONDS,
    sameSite: 'Strict'
  });
}

export function buildClearSessionCookie(secure: boolean): string {
  return buildCookie(USER_SESSION_COOKIE, '', { secure, maxAge: 0, sameSite: 'Strict' });
}

export { readCookie };

export function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === 'https:';
}

export async function createSession(env: SessionEnv, userId: number, authorKeyHex: string): Promise<string> {
  const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await sha256Hex(token);
  const now = Math.floor(Date.now() / 1000);
  // The author key is wrapped under a key derived from this session's token, so
  // the row can recover it later without the password or recovery code.
  const wrappedAuthorKey = await wrapHex(await sessionWrapKeyHex(token), authorKeyHex);
  // `created_at` is rounded to the hour so a session row cannot be matched
  // against edge logs by time, like votes, comments, and the account-cap rows.
  // `expires_at` stays exact: the sliding expiry depends on it and it reveals
  // nothing beyond "active within the last 30 days".
  const coarseNow = now - (now % 3600);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM user_sessions WHERE expires_at <= ?').bind(now),
    env.DB.prepare(
      'INSERT INTO user_sessions (token_hash, user_id, author_key, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(tokenHash, userId, wrappedAuthorKey, coarseNow, now + USER_SESSION_TTL_SECONDS)
  ]);
  return token;
}

export async function destroySession(env: SessionEnv, token: string): Promise<void> {
  const tokenHash = await sha256Hex(token);
  await env.DB.prepare('DELETE FROM user_sessions WHERE token_hash = ?').bind(tokenHash).run();
}

interface SessionRow {
  expires_at: number;
  user_id: number;
  username: string;
  status: number;
  author_key: string;
  created_at: number;
}

export async function getUserActor(request: Request, env: SessionEnv): Promise<UserActor | null> {
  const token = readCookie(request, USER_SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `SELECT s.expires_at, s.author_key, u.id AS user_id, u.username, u.status, u.created_at
     FROM user_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`
  ).bind(tokenHash).first<SessionRow>();

  if (!row) return null;
  if (row.status !== USER_STATUS_ACTIVE) return null;
  if (row.expires_at <= now) {
    await env.DB.prepare('DELETE FROM user_sessions WHERE token_hash = ?').bind(tokenHash).run();
    return null;
  }
  // The author key is wrapped under this session's token. A row that cannot be
  // unwrapped (tampered or written by another token) is treated as signed out and
  // removed.
  const authorKeyHex = await unwrapHex(await sessionWrapKeyHex(token), row.author_key);
  if (authorKeyHex === null) {
    await env.DB.prepare('DELETE FROM user_sessions WHERE token_hash = ?').bind(tokenHash).run();
    return null;
  }
  if (row.expires_at < now + USER_SESSION_TTL_SECONDS - SLIDE_THRESHOLD_SECONDS) {
    await env.DB.prepare('UPDATE user_sessions SET expires_at = ? WHERE token_hash = ?')
      .bind(now + USER_SESSION_TTL_SECONDS, tokenHash).run();
  }
  return {
    id: Number(row.user_id),
    username: row.username,
    createdAt: Number(row.created_at),
    authorKeyHex,
    authorMark: await authorMark(authorKeyHex)
  };
}

export type RequireUserResult =
  | { ok: true; user: UserActor; token: string }
  | { ok: false; response: Response };

export async function requireUser(request: Request, env: SessionEnv): Promise<RequireUserResult> {
  const user = await getUserActor(request, env);
  const token = readCookie(request, USER_SESSION_COOKIE);
  if (!user || !token) {
    return { ok: false, response: apiError('LOGIN_REQUIRED', 401, { extra: { ok: false } }) };
  }
  return { ok: true, user, token };
}
