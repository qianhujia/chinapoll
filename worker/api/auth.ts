// Public account endpoints: register, login, logout, and session status.
//
// Users sign up with a username and password only. There is no email or recovery
// flow, so the client must keep its credentials safe. Failed logins lock the
// account after a configurable number of attempts, per-IP account creation is
// capped, and both register and login are rate limited.

import { parseRateLimit, currentBucketStart } from '../services/rateLimit';
import { ipBucket } from '../services/ip';
import { hashPassword, verifyPassword } from '../services/password';
import { generateRecoveryCode, hashRecoveryCode, normalizeRecoveryCode } from '../services/recovery';
import {
  USER_STATUS_ACTIVE,
  normalizeUsername,
  validateUserPassword,
  validateUsername
} from '../services/users';
import {
  buildClearSessionCookie,
  buildSessionCookie,
  createSession,
  destroySession,
  getUserActor,
  isSecureRequest,
  readCookie,
  USER_SESSION_COOKIE,
  type UserActor
} from '../services/session';

interface AuthEnv {
  DB: D1Database;
  login_rate_limit?: string;
  register_rate_limit?: string;
  max_accounts_per_ip?: number;
  login_max_failed_attempts?: number;
  login_lock_minutes?: number;
}

const DEFAULT_LOGIN_RATE_LIMIT = '10/h';
const DEFAULT_REGISTER_RATE_LIMIT = '5/d';
const DEFAULT_MAX_ACCOUNTS_PER_IP = 4;
const DEFAULT_MAX_FAILED_ATTEMPTS = 5;
const DEFAULT_LOCK_MINUTES = 15;

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  status: number;
  failed_attempts: number;
  locked_until: number | null;
  created_at: number;
}

function noStoreJson(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, {
    status,
    headers: { 'cache-control': 'no-store', ...headers }
  });
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return typeof body === 'object' && body !== null ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function readString(body: Record<string, unknown> | null, key: string): string {
  if (!body) return '';
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

function bucketPrefix(request: Request): number {
  const remoteIp = request.headers.get('cf-connecting-ip') ?? '127.0.0.1';
  return ipBucket(remoteIp);
}

function publicUser(user: UserActor): { id: number; username: string; createdAt: string } {
  return {
    id: user.id,
    username: user.username,
    createdAt: new Date(user.createdAt * 1000).toISOString()
  };
}

async function countAttempts(db: D1Database, ipPrefix: number, kind: string, bucketStart: number): Promise<number> {
  const row = await db.prepare(
    'SELECT COUNT(*) AS total FROM auth_attempts WHERE ip_prefix = ? AND kind = ? AND ts_bucket = ?'
  ).bind(ipPrefix, kind, bucketStart).first<{ total: number }>();
  return Number(row?.total ?? 0);
}

const ATTEMPT_RETENTION_SECONDS = 7 * 24 * 60 * 60;

async function recordAttempt(db: D1Database, ipPrefix: number, kind: string, bucketStart: number): Promise<void> {
  // Drop attempts outside the retention window so the table stays bounded.
  await db.batch([
    db.prepare('DELETE FROM auth_attempts WHERE created_at < unixepoch() - ?').bind(ATTEMPT_RETENTION_SECONDS),
    db.prepare('INSERT INTO auth_attempts (ip_prefix, kind, ts_bucket) VALUES (?, ?, ?)')
      .bind(ipPrefix, kind, bucketStart)
  ]);
}

export async function handleAuthRequest(request: Request, url: URL, env: AuthEnv): Promise<Response> {
  if (url.pathname === '/api/auth/session') {
    return sessionStatus(request, env);
  }
  if (url.pathname === '/api/auth/register') {
    if (request.method !== 'POST') return noStoreJson({ message: 'method not allowed' }, 405);
    return register(request, env);
  }
  if (url.pathname === '/api/auth/login') {
    if (request.method !== 'POST') return noStoreJson({ message: 'method not allowed' }, 405);
    return login(request, env);
  }
  if (url.pathname === '/api/auth/recover') {
    if (request.method !== 'POST') return noStoreJson({ message: 'method not allowed' }, 405);
    return recover(request, env);
  }
  if (url.pathname === '/api/auth/logout') {
    if (request.method !== 'POST' && request.method !== 'DELETE') return noStoreJson({ message: 'method not allowed' }, 405);
    return logout(request, env);
  }
  return noStoreJson({ message: 'not found' }, 404);
}

async function sessionStatus(request: Request, env: AuthEnv): Promise<Response> {
  if (request.method !== 'GET') return noStoreJson({ message: 'method not allowed' }, 405);
  const user = await getUserActor(request, env);
  return noStoreJson({
    authenticated: user !== null,
    user: user ? publicUser(user) : null
  });
}

async function register(request: Request, env: AuthEnv): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body) return noStoreJson({ message: 'invalid JSON' }, 400);

  const usernameResult = validateUsername(readString(body, 'username'));
  if (!usernameResult.ok) return noStoreJson({ message: usernameResult.error }, 422);

  const password = readString(body, 'password');
  const passwordResult = validateUserPassword(password);
  if (!passwordResult.ok) return noStoreJson({ message: passwordResult.error }, 422);

  const ipPrefix = bucketPrefix(request);

  // Per-IP account cap: one network bucket may only register a configurable
  // number of accounts.
  const maxAccounts = Number(env.max_accounts_per_ip ?? DEFAULT_MAX_ACCOUNTS_PER_IP);
  const accountRow = await env.DB.prepare(
    'SELECT COUNT(*) AS total FROM users WHERE ip_prefix = ?'
  ).bind(ipPrefix).first<{ total: number }>();
  if (Number(accountRow?.total ?? 0) >= maxAccounts) {
    return noStoreJson({ message: 'too many accounts have been registered from this network' }, 429);
  }

  const { count: registerLimit, windowMs } = parseRateLimit(env.register_rate_limit, DEFAULT_REGISTER_RATE_LIMIT);
  const bucketStart = currentBucketStart(windowMs);
  if (await countAttempts(env.DB, ipPrefix, 'register', bucketStart) >= registerLimit) {
    return noStoreJson({ message: 'registration rate limit reached' }, 429);
  }
  await recordAttempt(env.DB, ipPrefix, 'register', bucketStart);

  const passwordHash = await hashPassword(password);
  // Issue the first recovery code. The plaintext code is returned here only; the
  // database keeps just its hash.
  const recoveryCode = await generateRecoveryCode();
  let userId: number;
  try {
    const result = await env.DB.prepare(
      `INSERT INTO users (username, password_hash, status, ip_prefix, recovery_code_hash, recovery_code_updated_at)
       VALUES (?, ?, ?, ?, ?, unixepoch())`
    ).bind(usernameResult.value, passwordHash, USER_STATUS_ACTIVE, ipPrefix, recoveryCode.hash).run();
    userId = Number(result.meta.last_row_id);
  } catch {
    return noStoreJson({ message: 'username is already taken' }, 409);
  }

  const token = await createSession(env, userId);
  return noStoreJson({
    ok: true,
    user: { id: userId, username: usernameResult.value },
    recoveryCode: recoveryCode.code
  }, 201, { 'set-cookie': buildSessionCookie(token, isSecureRequest(request)) });
}

async function login(request: Request, env: AuthEnv): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body) return noStoreJson({ message: 'invalid JSON' }, 400);

  const username = normalizeUsername(readString(body, 'username'));
  const password = readString(body, 'password');
  if (!username || !password) {
    return noStoreJson({ message: 'username and password are required' }, 400);
  }

  const ipPrefix = bucketPrefix(request);

  // Login rate limit per network bucket.
  const { count: loginLimit, windowMs } = parseRateLimit(env.login_rate_limit, DEFAULT_LOGIN_RATE_LIMIT);
  const bucketStart = currentBucketStart(windowMs);
  if (await countAttempts(env.DB, ipPrefix, 'login', bucketStart) >= loginLimit) {
    return noStoreJson({ message: 'too many login attempts; try again later' }, 429);
  }
  await recordAttempt(env.DB, ipPrefix, 'login', bucketStart);

  const user = await env.DB.prepare(
    `SELECT id, username, password_hash, status, failed_attempts, locked_until, created_at
     FROM users WHERE username = ?`
  ).bind(username).first<UserRow>();

  const maxFailed = Number(env.login_max_failed_attempts ?? DEFAULT_MAX_FAILED_ATTEMPTS);
  const lockMinutes = Number(env.login_lock_minutes ?? DEFAULT_LOCK_MINUTES);
  const now = Math.floor(Date.now() / 1000);

  if (!user) {
    return noStoreJson({ message: 'invalid username or password' }, 401);
  }
  if (user.status !== USER_STATUS_ACTIVE) {
    return noStoreJson({ message: 'this account is disabled' }, 403);
  }
  if (user.locked_until && user.locked_until > now) {
    return noStoreJson({
      message: 'account temporarily locked after too many failed attempts',
      locked: true,
      retryAfter: user.locked_until - now
    }, 423);
  }

  if (!await verifyPassword(password, user.password_hash)) {
    const attempts = Number(user.failed_attempts) + 1;
    if (attempts >= maxFailed) {
      const lockedUntil = now + lockMinutes * 60;
      await env.DB.prepare(
        'UPDATE users SET failed_attempts = 0, locked_until = ?, updated_at = unixepoch() WHERE id = ?'
      ).bind(lockedUntil, user.id).run();
      return noStoreJson({
        message: `too many failed attempts; account locked for ${lockMinutes} minutes`,
        locked: true,
        retryAfter: lockedUntil - now
      }, 423);
    }
    await env.DB.prepare(
      'UPDATE users SET failed_attempts = ?, updated_at = unixepoch() WHERE id = ?'
    ).bind(attempts, user.id).run();
    return noStoreJson({
      message: 'invalid username or password',
      remainingAttempts: maxFailed - attempts
    }, 401);
  }

  await env.DB.prepare(
    'UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = unixepoch(), updated_at = unixepoch() WHERE id = ?'
  ).bind(user.id).run();

  const token = await createSession(env, user.id);
  const actor: UserActor = { id: user.id, username: user.username, createdAt: Number(user.created_at) };
  return noStoreJson({ ok: true, user: publicUser(actor) }, 200, {
    'set-cookie': buildSessionCookie(token, isSecureRequest(request))
  });
}

async function logout(request: Request, env: AuthEnv): Promise<Response> {
  const token = readCookie(request, USER_SESSION_COOKIE);
  if (token) await destroySession(env, token);
  return noStoreJson({ ok: true }, 200, {
    'set-cookie': buildClearSessionCookie(isSecureRequest(request))
  });
}
// Self-service password recovery with a single-use recovery code. The response
// is deliberately generic so it does not reveal whether a username exists.
async function recover(request: Request, env: AuthEnv): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body) return noStoreJson({ message: 'invalid JSON' }, 400);

  const invalid = noStoreJson({ message: 'invalid username or recovery code' }, 401);

  const usernameResult = validateUsername(readString(body, 'username'));
  if (!usernameResult.ok) return invalid;

  const newPassword = readString(body, 'newPassword');
  const passwordResult = validateUserPassword(newPassword);
  if (!passwordResult.ok) return noStoreJson({ message: passwordResult.error }, 422);

  const code = normalizeRecoveryCode(readString(body, 'code'));
  if (!code) return invalid;

  // Recovery attempts share the login rate limit so a network bucket cannot
  // hammer the endpoint.
  const ipPrefix = bucketPrefix(request);
  const { count: recoverLimit, windowMs } = parseRateLimit(env.login_rate_limit, DEFAULT_LOGIN_RATE_LIMIT);
  const bucketStart = currentBucketStart(windowMs);
  if (await countAttempts(env.DB, ipPrefix, 'recover', bucketStart) >= recoverLimit) {
    return noStoreJson({ message: 'too many recovery attempts; try again later' }, 429);
  }
  await recordAttempt(env.DB, ipPrefix, 'recover', bucketStart);

  const user = await env.DB.prepare(
    'SELECT id, status, recovery_code_hash FROM users WHERE username = ?'
  ).bind(usernameResult.value).first<{ id: number; status: number; recovery_code_hash: string | null }>();
  if (!user || user.status !== USER_STATUS_ACTIVE || !user.recovery_code_hash) return invalid;

  const passwordHash = await hashPassword(newPassword);
  const providedHash = await hashRecoveryCode(code);
  // Consume and rotate the code in a single statement: the WHERE clause matches
  // only the current code, which makes the update atomic (a code can never be
  // used twice) and leaves the account with a fresh code.
  const nextCode = await generateRecoveryCode();
  const updated = await env.DB.prepare(
    `UPDATE users
     SET password_hash = ?, recovery_code_hash = ?, recovery_code_updated_at = unixepoch(),
         failed_attempts = 0, locked_until = NULL, updated_at = unixepoch()
     WHERE id = ? AND recovery_code_hash = ?`
  ).bind(passwordHash, nextCode.hash, user.id, providedHash).run();
  if (Number(updated.meta.changes ?? 0) !== 1) return invalid;

  // Sign out every device so old sessions cannot outlive the reset.
  await env.DB.prepare('DELETE FROM user_sessions WHERE user_id = ?').bind(user.id).run();

  return noStoreJson({ ok: true, recoveryCode: nextCode.code });
}
