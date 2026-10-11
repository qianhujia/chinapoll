// Session handling for public user accounts.
//
// A successful sign-in creates a server-side session with a 30-day sliding
// expiry; the random session token is stored in an HttpOnly, SameSite=Lax cookie
// and only its SHA-256 hash is kept in the database.

import { sha256 } from './hashchain';
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

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function cookieAttributes(value: string, secure: boolean, maxAge: number): string {
  const attributes = [value, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

export function buildSessionCookie(token: string, secure: boolean): string {
  return cookieAttributes(`${USER_SESSION_COOKIE}=${encodeURIComponent(token)}`, secure, USER_SESSION_TTL_SECONDS);
}

export function buildClearSessionCookie(secure: boolean): string {
  return cookieAttributes(`${USER_SESSION_COOKIE}=`, secure, 0);
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    if (key === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return null;
}

export function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === 'https:';
}

export async function createSession(env: SessionEnv, userId: number): Promise<string> {
  const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await sha256(token);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM user_sessions WHERE expires_at <= ?').bind(now),
    env.DB.prepare(
      'INSERT INTO user_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
    ).bind(tokenHash, userId, now, now + USER_SESSION_TTL_SECONDS)
  ]);
  return token;
}

export async function destroySession(env: SessionEnv, token: string): Promise<void> {
  const tokenHash = await sha256(token);
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
  const tokenHash = await sha256(token);
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
