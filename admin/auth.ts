// Session-based authentication for the standalone admin Worker.
//
// Admin users sign in with a username and password. A successful sign-in creates
// a server-side session with a 30-minute sliding expiry; the session token is
// stored in an HttpOnly cookie for the dashboard. Scripts may also send the
// session token as an `Authorization: Bearer` header.

import { ADMIN_STATUS_ACTIVE, adminRoleLabel, type AdminRole } from './lib/admins';
import { sha256Hex, toHex } from './lib/crypto';

export const SESSION_COOKIE_NAME = 'chinapoll_admin_session';
export const SESSION_TTL_SECONDS = 30 * 60;
// Active sessions are extended at most about once per minute to limit writes.
const SESSION_SLIDE_THRESHOLD_SECONDS = 60;

export interface AdminEnv {
  DB: D1Database;
  /** Public Turnstile site key rendered by the login form. */
  TURNSTILE_SITE_KEY?: string;
  /** Optional extra origin allowed for cookie-authenticated mutations. */
  ADMIN_ORIGIN?: string;
}

export interface AdminActor {
  id: number;
  username: string;
  role: AdminRole;
}

export interface AuthenticatedContext {
  actor: AdminActor;
  token: string;
  viaCookie: boolean;
}

export type AuthResult =
  | { ok: true; context: AuthenticatedContext }
  | { ok: false; response: Response };

function cookieAttributes(value: string, secure: boolean, maxAge: number): string {
  const attributes = [value, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

export function buildSessionCookie(token: string, secure: boolean): string {
  return cookieAttributes(`${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`, secure, SESSION_TTL_SECONDS);
}

export function buildClearSessionCookie(secure: boolean): string {
  return cookieAttributes(`${SESSION_COOKIE_NAME}=`, secure, 0);
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

function readBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export async function createSession(env: AdminEnv, adminUserId: number): Promise<string> {
  const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await sha256Hex(token);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').bind(now),
    env.DB.prepare(
      'INSERT INTO admin_sessions (token_hash, admin_user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
    ).bind(tokenHash, adminUserId, now, now + SESSION_TTL_SECONDS)
  ]);
  return token;
}

export async function destroySession(env: AdminEnv, token: string): Promise<void> {
  const tokenHash = await sha256Hex(token);
  await env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').bind(tokenHash).run();
}

interface SessionRow {
  expires_at: number;
  user_id: number;
  username: string;
  status: number;
  role: number;
}

async function resolveSession(env: AdminEnv, token: string): Promise<AdminActor | null> {
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `SELECT s.expires_at, u.id AS user_id, u.username, u.status, u.role
     FROM admin_sessions s
     JOIN admin_users u ON u.id = s.admin_user_id
     WHERE s.token_hash = ?`
  ).bind(tokenHash).first<SessionRow>();

  if (!row) return null;
  if (row.status !== ADMIN_STATUS_ACTIVE) return null;
  if (row.expires_at <= now) {
    await env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').bind(tokenHash).run();
    return null;
  }
  if (row.expires_at < now + SESSION_TTL_SECONDS - SESSION_SLIDE_THRESHOLD_SECONDS) {
    await env.DB.prepare('UPDATE admin_sessions SET expires_at = ? WHERE token_hash = ?')
      .bind(now + SESSION_TTL_SECONDS, tokenHash).run();
  }
  return { id: Number(row.user_id), username: row.username, role: adminRoleLabel(Number(row.role)) };
}

export async function getSessionContext(request: Request, env: AdminEnv): Promise<AuthenticatedContext | null> {
  const headerToken = readBearerToken(request);
  const cookieToken = headerToken ? null : readCookie(request, SESSION_COOKIE_NAME);
  const token = headerToken ?? cookieToken;
  if (!token) return null;
  const actor = await resolveSession(env, token);
  if (!actor) return null;
  return { actor, token, viaCookie: headerToken === null };
}

export async function authenticate(request: Request, env: AdminEnv): Promise<AuthResult> {
  const context = await getSessionContext(request, env);
  if (!context) {
    return { ok: false, response: Response.json({ message: 'unauthorized' }, { status: 401 }) };
  }
  return { ok: true, context };
}

// Cookie-authenticated mutations must originate from the Worker itself (or the
// configured ADMIN_ORIGIN) to block cross-site request forgery.
export function enforceSameOrigin(
  request: Request,
  env: AdminEnv,
  context: AuthenticatedContext
): Response | null {
  if (!context.viaCookie) return null;
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;

  const origin = request.headers.get('origin');
  const requestOrigin = new URL(request.url).origin;
  const allowed = new Set([requestOrigin]);
  if (env.ADMIN_ORIGIN) {
    try {
      allowed.add(new URL(env.ADMIN_ORIGIN).origin);
    } catch {
      // Ignore a malformed ADMIN_ORIGIN value.
    }
  }

  if (!origin || !allowed.has(origin)) {
    return Response.json({ message: 'cross-origin request rejected' }, { status: 403 });
  }

  return null;
}
