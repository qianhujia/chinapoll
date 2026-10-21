// Session-based authentication for the standalone admin Worker.
//
// Admin users sign in with a username and password. A successful sign-in creates
// a server-side session with a 30-minute sliding expiry; the session token is
// stored in an HttpOnly cookie for the dashboard. Scripts may also send the
// session token as an `Authorization: Bearer` header.

import { ADMIN_STATUS_ACTIVE, adminRoleLabel, type AdminRole } from './lib/admins';
import { sha256Hex, toHex } from '../shared/crypto';
import { enforceSameOrigin as enforceSameOriginShared } from '../worker/services/csrf';

export const SESSION_COOKIE_NAME = 'chinapoll_admin_session';
export const SESSION_TTL_SECONDS = 30 * 60;
// Active sessions are extended at most about once per minute to limit writes.
const SESSION_SLIDE_THRESHOLD_SECONDS = 60;
// Admins are few, sessions last 30 minutes, and a stale admin session is a real
// risk, so an admin holds a single active session: signing in elsewhere ends the
// previous one. Kept as a constant because it is a deliberate policy choice, not
// an implementation detail.
export const ADMIN_SINGLE_SESSION = true;

export interface AdminEnv {
  DB: D1Database;
  /** Bound RateLimiter Durable Object used for login and setup throttling. */
  RATE_LIMITER: DurableObjectNamespace;
  /** Bound PasswordHasher Durable Object used for all admin password hashing. */
  PASSWORD_HASHER: DurableObjectNamespace;
  /** Public Turnstile site key rendered by the login form. */
  TURNSTILE_SITE_KEY?: string;
  /** Private Turnstile key used to verify login tokens. Turnstile is enabled only
   * when both keys are set, so an unset key disables the widget and the check. */
  TURNSTILE_SECRET_KEY?: string;
  /** Optional extra origin allowed for cookie-authenticated mutations. */
  ADMIN_ORIGIN?: string;
  /** Optional origin of the public site, used to link to a poll from the dashboard. */
  PUBLIC_SITE_ORIGIN?: string;
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
  // `created_at` is rounded to the hour so a session row cannot be matched
  // against edge logs by time; `expires_at` stays exact because the sliding
  // expiry depends on it.
  const coarseNow = now - (now % 3600);
  const statements = [
    env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').bind(now)
  ];
  if (ADMIN_SINGLE_SESSION) {
    // Single session per admin: the login that is being completed replaces any
    // session this admin already had.
    statements.push(
      env.DB.prepare('DELETE FROM admin_sessions WHERE admin_user_id = ?').bind(adminUserId)
    );
  }
  statements.push(
    env.DB.prepare(
      'INSERT INTO admin_sessions (token_hash, admin_user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
    ).bind(tokenHash, adminUserId, coarseNow, now + SESSION_TTL_SECONDS)
  );
  await env.DB.batch(statements);
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
// configured ADMIN_ORIGIN) to block cross-site request forgery. The shared
// helper in worker/services/csrf.ts backs the public Worker as well.
export function enforceSameOrigin(
  request: Request,
  env: AdminEnv,
  context: AuthenticatedContext
): Response | null {
  return enforceSameOriginShared(request, {
    viaCookie: context.viaCookie,
    extraOrigin: env.ADMIN_ORIGIN
  });
}
