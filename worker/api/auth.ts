// Public account endpoints: register, login, logout, and session status.
//
// Users sign up with a username and password only. There is no email recovery
// channel; a single recovery code is the only way back in. The per-network
// account cap is enforced from `auth_attempts`, which stores a keyed,
// daily-rotated hash rather than an address. Rate limiting uses the RateLimiter
// Durable Object. Login responses are deliberately generic so they never
// confirm whether a username exists.

import type { HandlerEnv } from '../index';
import { checkRateLimit } from '../services/rateLimit';
import { clientAddress, hashedNetworkBucket, serverHmacKey } from '../services/ip';
import { isTurnstileEnabled, turnstileSecretKey, verifyTurnstile } from '../services/turnstile';
import { enforceSameOrigin } from '../services/csrf';
import { PBKDF2_ITERATIONS, passwordIterations } from '../../shared/password';
import { hashPassword, verifyPassword } from '../services/passwordHasher';
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

const DEFAULT_LOGIN_RATE_LIMIT = '10/h';
const DEFAULT_REGISTER_RATE_LIMIT = '5/d';
const DEFAULT_MAX_ACCOUNTS_PER_IP = 4;
const DEFAULT_MAX_FAILED_ATTEMPTS = 5;
const DEFAULT_LOCK_MINUTES = 15;
// One network bucket may create at most `max_accounts_per_ip` accounts in any
// rolling window. The cap hash rotates per calendar month (see ip.ts) and the
// window covers the longest month, so rows from the current month still match.
const ACCOUNT_CAP_WINDOW_SECONDS = 31 * 24 * 60 * 60;
const GENERIC_LOGIN_ERROR = 'invalid username or password';

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

function publicUser(user: UserActor): { id: number; username: string; createdAt: string } {
  return {
    id: user.id,
    username: user.username,
    createdAt: new Date(user.createdAt * 1000).toISOString()
  };
}

async function countAccounts(db: D1Database, ipHash: string): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS total FROM auth_attempts
     WHERE ip_hash = ? AND kind = 'account' AND created_at >= unixepoch() - ?`
  ).bind(ipHash, ACCOUNT_CAP_WINDOW_SECONDS).first<{ total: number }>();
  return Number(row?.total ?? 0);
}

async function recordAccount(db: D1Database, ipHash: string): Promise<void> {
  // The hourly cron purges stale rows, so no inline delete is needed here.
  // `created_at` is rounded to the hour; the cap only needs day resolution.
  const coarseNow = Math.floor(Date.now() / 1000 / 3600) * 3600;
  await db.prepare(
    "INSERT INTO auth_attempts (ip_hash, kind, created_at) VALUES (?, 'account', ?)"
  ).bind(ipHash, coarseNow).run();
}

// Verifies the Turnstile token when both keys are configured.
async function turnstileGate(
  request: Request,
  env: HandlerEnv,
  body: Record<string, unknown> | null
): Promise<Response | null> {
  if (!isTurnstileEnabled(env)) return null;
  const token = readString(body, 'turnstileToken');
  if (!token || !await verifyTurnstile(turnstileSecretKey(env), token, new URL(request.url).hostname)) {
    return noStoreJson({ message: 'turnstile verification failed' }, 403);
  }
  return null;
}

export async function handleAuthRequest(request: Request, url: URL, env: HandlerEnv): Promise<Response> {
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

async function sessionStatus(request: Request, env: HandlerEnv): Promise<Response> {
  if (request.method !== 'GET') return noStoreJson({ message: 'method not allowed' }, 405);
  const user = await getUserActor(request, env);
  return noStoreJson({
    authenticated: user !== null,
    user: user ? publicUser(user) : null
  });
}
async function register(request: Request, env: HandlerEnv): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body) return noStoreJson({ message: 'invalid JSON' }, 400);

  const usernameResult = validateUsername(readString(body, 'username'));
  if (!usernameResult.ok) return noStoreJson({ message: usernameResult.error }, 422);

  const password = readString(body, 'password');
  const passwordResult = validateUserPassword(password, usernameResult.value);
  if (!passwordResult.ok) return noStoreJson({ message: passwordResult.error }, 422);

  const turnstileError = await turnstileGate(request, env, body);
  if (turnstileError) return turnstileError;

  // Rate limiting uses the daily hash; the account cap uses the monthly hash so
  // it stays effective across the whole calendar month.
  const dayHash = await hashedNetworkBucket(clientAddress(request), serverHmacKey(env), new Date(), 'day');
  const monthHash = await hashedNetworkBucket(clientAddress(request), serverHmacKey(env), new Date(), 'month');
  if (!dayHash || !monthHash) return noStoreJson({ message: 'server key is not configured' }, 503);

  // Per-network account cap: one bucket may only register a configurable number
  // of accounts within the rolling window.
  const maxAccounts = Number(env.max_accounts_per_ip ?? DEFAULT_MAX_ACCOUNTS_PER_IP);
  if (await countAccounts(env.DB, monthHash) >= maxAccounts) {
    return noStoreJson({ message: 'too many accounts have been registered from this network' }, 429);
  }

  const limited = await checkRateLimit(env, 'register', dayHash, env.register_rate_limit, DEFAULT_REGISTER_RATE_LIMIT);
  if (!limited.allowed) {
    return noStoreJson({ message: 'registration rate limit reached' }, 429);
  }

  const passwordHash = await hashPassword(env, usernameResult.value, password);
  // Issue the first recovery code. The plaintext code is returned here only; the
  // database keeps just its hash.
  const recoveryCode = await generateRecoveryCode();
  let userId: number;
  try {
    const result = await env.DB.prepare(
      `INSERT INTO users (username, password_hash, status, recovery_code_hash, recovery_code_updated_at)
       VALUES (?, ?, ?, ?, unixepoch())`
    ).bind(usernameResult.value, passwordHash, USER_STATUS_ACTIVE, recoveryCode.hash).run();
    userId = Number(result.meta.last_row_id);
  } catch {
    return noStoreJson({ message: 'username is already taken' }, 409);
  }

  await recordAccount(env.DB, monthHash);

  const token = await createSession(env, userId);
  return noStoreJson({
    ok: true,
    user: { id: userId, username: usernameResult.value },
    recoveryCode: recoveryCode.code
  }, 201, { 'set-cookie': buildSessionCookie(token, isSecureRequest(request)) });
}

async function login(request: Request, env: HandlerEnv): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body) return noStoreJson({ message: 'invalid JSON' }, 400);

  const username = normalizeUsername(readString(body, 'username'));
  const password = readString(body, 'password');
  if (!username || !password) {
    return noStoreJson({ message: 'username and password are required' }, 400);
  }

  const turnstileError = await turnstileGate(request, env, body);
  if (turnstileError) return turnstileError;

  const ipHash = await hashedNetworkBucket(clientAddress(request), serverHmacKey(env), new Date(), 'day');
  if (!ipHash) return noStoreJson({ message: 'server key is not configured' }, 503);

  const limited = await checkRateLimit(env, 'login', ipHash, env.login_rate_limit, DEFAULT_LOGIN_RATE_LIMIT);
  if (!limited.allowed) {
    return noStoreJson({ message: 'too many login attempts; try again later' }, 429);
  }

  const user = await env.DB.prepare(
    `SELECT id, username, password_hash, status, failed_attempts, locked_until, created_at
     FROM users WHERE username = ?`
  ).bind(username).first<UserRow>();

  const maxFailed = Number(env.login_max_failed_attempts ?? DEFAULT_MAX_FAILED_ATTEMPTS);
  const lockMinutes = Number(env.login_lock_minutes ?? DEFAULT_LOCK_MINUTES);
  const now = Math.floor(Date.now() / 1000);

  // Every failure mode returns the same generic message so the endpoint cannot
  // confirm whether a username exists or is disabled or locked.
  if (!user || user.status !== USER_STATUS_ACTIVE || (user.locked_until !== null && user.locked_until > now)) {
    return noStoreJson({ message: GENERIC_LOGIN_ERROR }, 401);
  }

  if (!await verifyPassword(env, username, password, user.password_hash)) {
    const attempts = Number(user.failed_attempts) + 1;
    if (attempts >= maxFailed) {
      const lockedUntil = now + lockMinutes * 60;
      await env.DB.prepare(
        'UPDATE users SET failed_attempts = 0, locked_until = ?, updated_at = unixepoch() WHERE id = ?'
      ).bind(lockedUntil, user.id).run();
    } else {
      await env.DB.prepare(
        'UPDATE users SET failed_attempts = ?, updated_at = unixepoch() WHERE id = ?'
      ).bind(attempts, user.id).run();
    }
    return noStoreJson({ message: GENERIC_LOGIN_ERROR }, 401);
  }

  // Rehash with the current iteration count when the stored hash predates it.
  const storedIterations = passwordIterations(user.password_hash);
  const nextHash = storedIterations !== null && storedIterations < PBKDF2_ITERATIONS
    ? await hashPassword(env, username, password)
    : null;

  // last_login_at is rounded to the day so it cannot be joined against precise
  // activity timestamps.
  const dayStart = now - (now % 86400);
  await env.DB.prepare(
    `UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ?, updated_at = unixepoch(),
       password_hash = COALESCE(?, password_hash)
     WHERE id = ?`
  ).bind(dayStart, nextHash, user.id).run();

  const token = await createSession(env, user.id);
  const actor: UserActor = { id: user.id, username: user.username, createdAt: Number(user.created_at) };
  return noStoreJson({ ok: true, user: publicUser(actor) }, 200, {
    'set-cookie': buildSessionCookie(token, isSecureRequest(request))
  });
}
async function logout(request: Request, env: HandlerEnv): Promise<Response> {
  // Logout is cookie-authenticated, so it needs the same-origin check.
  const csrf = enforceSameOrigin(request, { viaCookie: true });
  if (csrf) return csrf;

  const token = readCookie(request, USER_SESSION_COOKIE);
  if (token) await destroySession(env, token);
  return noStoreJson({ ok: true }, 200, {
    'set-cookie': buildClearSessionCookie(isSecureRequest(request))
  });
}

// Self-service password recovery with a single-use recovery code. The response
// is deliberately generic so it does not reveal whether a username exists.
async function recover(request: Request, env: HandlerEnv): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body) return noStoreJson({ message: 'invalid JSON' }, 400);

  const invalid = noStoreJson({ message: 'invalid username or recovery code' }, 401);

  const usernameResult = validateUsername(readString(body, 'username'));
  if (!usernameResult.ok) return invalid;

  const newPassword = readString(body, 'newPassword');
  const passwordResult = validateUserPassword(newPassword, usernameResult.value);
  if (!passwordResult.ok) return noStoreJson({ message: passwordResult.error }, 422);

  const code = normalizeRecoveryCode(readString(body, 'code'));
  if (!code) return invalid;

  const ipHash = await hashedNetworkBucket(clientAddress(request), serverHmacKey(env), new Date(), 'day');
  if (!ipHash) return noStoreJson({ message: 'server key is not configured' }, 503);

  // Recovery attempts share the login rate limit.
  const limited = await checkRateLimit(env, 'recover', ipHash, env.login_rate_limit, DEFAULT_LOGIN_RATE_LIMIT);
  if (!limited.allowed) {
    return noStoreJson({ message: 'too many recovery attempts; try again later' }, 429);
  }

  const user = await env.DB.prepare(
    'SELECT id, status, recovery_code_hash FROM users WHERE username = ?'
  ).bind(usernameResult.value).first<{ id: number; status: number; recovery_code_hash: string | null }>();
  if (!user || user.status !== USER_STATUS_ACTIVE || !user.recovery_code_hash) return invalid;

  const passwordHash = await hashPassword(env, usernameResult.value, newPassword);
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
