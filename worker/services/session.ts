// Session handling for public user accounts.
//
// A successful sign-in creates a server-side session with a 30-day sliding
// expiry; the random session token is stored in an HttpOnly, SameSite=Strict
// cookie and only its SHA-256 hash is kept in the database.

import { buildCookie, readCookie } from '../../shared/cookies';
import { sha256Hex, toHex } from '../../shared/crypto';
import { USER_STATUS_ACTIVE } from './users';

export const USER_SESSION_COOKIE = 'chinapoll_user_session';
export const USER_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
// Active sessions are extended at most about once per minute to limit writes.
const SLIDE_THRESHOLD_SECONDS = 60;

export interface UserActor {
  id: number;
  username: string;
  createdAt: number;
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

export async function createSession(env: SessionEnv, userId: number): Promise<string> {
  const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await sha256Hex(token);
  const now = Math.floor(Date.now() / 1000);
  // `created_at` is rounded to the hour so a session row cannot be matched
  // against edge logs by time, like votes, comments, and the account-cap rows.
  // `expires_at` stays exact: the sliding expiry depends on it and it reveals
  // nothing beyond "active within the last 30 days".
  const coarseNow = now - (now % 3600);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM user_sessions WHERE expires_at <= ?').bind(now),
    env.DB.prepare(
      'INSERT INTO user_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
    ).bind(tokenHash, userId, coarseNow, now + USER_SESSION_TTL_SECONDS)
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
  created_at: number;
}

export async function getUserActor(request: Request, env: SessionEnv): Promise<UserActor | null> {
  const token = readCookie(request, USER_SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `SELECT s.expires_at, u.id AS user_id, u.username, u.status, u.created_at
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
  if (row.expires_at < now + USER_SESSION_TTL_SECONDS - SLIDE_THRESHOLD_SECONDS) {
    await env.DB.prepare('UPDATE user_sessions SET expires_at = ? WHERE token_hash = ?')
      .bind(now + USER_SESSION_TTL_SECONDS, tokenHash).run();
  }
  return { id: Number(row.user_id), username: row.username, createdAt: Number(row.created_at) };
}

export type RequireUserResult =
  | { ok: true; user: UserActor; token: string }
  | { ok: false; response: Response };

export async function requireUser(request: Request, env: SessionEnv): Promise<RequireUserResult> {
  const user = await getUserActor(request, env);
  const token = readCookie(request, USER_SESSION_COOKIE);
  if (!user || !token) {
    return { ok: false, response: Response.json({ ok: false, message: 'login required' }, { status: 401 }) };
  }
  return { ok: true, user, token };
}
