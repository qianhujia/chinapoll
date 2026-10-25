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
import {
  PBKDF2_ITERATIONS,
  formatUserPasswordHash,
  parseUserPasswordHash
} from '../../shared/password';
import { derivePasswordMaterialRemote } from '../services/passwordHasher';
import { constantTimeEqual, unwrapHex, wrapHex } from '../../shared/crypto';
import { authorMark, newAuthorKeyHex, recoveryWrapKeyHex } from '../services/author';
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
import { apiError } from '../../shared/http';

const DEFAULT_LOGIN_RATE_LIMIT = '10/h';
const DEFAULT_REGISTER_RATE_LIMIT = '5/d';
const DEFAULT_MAX_ACCOUNTS_PER_IP = 4;
const DEFAULT_MAX_FAILED_ATTEMPTS = 5;
const DEFAULT_LOCK_MINUTES = 15;
// One network bucket may create at most `max_accounts_per_ip` accounts in any
// rolling window. The cap hash rotates per calendar month (see ip.ts) and the
// window covers the longest month, so rows from the current month still match.
const ACCOUNT_CAP_WINDOW_SECONDS = 31 * 24 * 60 * 60;

// Sign-in failures answer with INVALID_CREDENTIALS, whose message is the same
// generic "invalid username or password" for every failure mode.

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  status: number;
  failed_attempts: number;
  locked_until: number | null;
  author_key_pw: string;
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
    return apiError('TURNSTILE_FAILED', 403);
  }
  return null;
}

export async function handleAuthRequest(request: Request, url: URL, env: HandlerEnv): Promise<Response> {
  if (url.pathname === '/api/auth/session') {
    return sessionStatus(request, env);
  }
  if (url.pathname === '/api/auth/register') {
    if (request.method !== 'POST') return apiError('METHOD_NOT_ALLOWED', 405);
    return register(request, env);
  }
  if (url.pathname === '/api/auth/login') {
    if (request.method !== 'POST') return apiError('METHOD_NOT_ALLOWED', 405);
    return login(request, env);
  }
  if (url.pathname === '/api/auth/recover') {
    if (request.method !== 'POST') return apiError('METHOD_NOT_ALLOWED', 405);
    return recover(request, env);
  }
  if (url.pathname === '/api/auth/logout') {
    if (request.method !== 'POST' && request.method !== 'DELETE') return apiError('METHOD_NOT_ALLOWED', 405);
    return logout(request, env);
  }
  return apiError('RESOURCE_NOT_FOUND', 404);
}

async function sessionStatus(request: Request, env: HandlerEnv): Promise<Response> {
  if (request.method !== 'GET') return apiError('METHOD_NOT_ALLOWED', 405);
  const user = await getUserActor(request, env);
  return noStoreJson({
    authenticated: user !== null,
    user: user ? publicUser(user) : null
  });
}
async function register(request: Request, env: HandlerEnv): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body) return apiError('INVALID_JSON', 400);

  const usernameResult = validateUsername(readString(body, 'username'));
  if (!usernameResult.ok) return apiError(usernameResult.code, 422, { params: usernameResult.params });

  const password = readString(body, 'password');
  const passwordResult = validateUserPassword(password, usernameResult.value);
  if (!passwordResult.ok) return apiError(passwordResult.code, 422, { params: passwordResult.params });

  const turnstileError = await turnstileGate(request, env, body);
  if (turnstileError) return turnstileError;

  // Rate limiting uses the daily hash; the account cap uses the monthly hash so
  // it stays effective across the whole calendar month.
  const dayHash = await hashedNetworkBucket(clientAddress(request), serverHmacKey(env), new Date(), 'day');
  const monthHash = await hashedNetworkBucket(clientAddress(request), serverHmacKey(env), new Date(), 'month');
  if (!dayHash || !monthHash) return apiError('SERVER_NOT_CONFIGURED', 503);

  // Per-network account cap: one bucket may only register a configurable number
  // of accounts within the rolling window.
  const maxAccounts = Number(env.max_accounts_per_ip ?? DEFAULT_MAX_ACCOUNTS_PER_IP);
  if (await countAccounts(env.DB, monthHash) >= maxAccounts) {
    return apiError('NETWORK_ACCOUNT_LIMIT', 429);
  }

  const limited = await checkRateLimit(env, 'register', dayHash, env.register_rate_limit, DEFAULT_REGISTER_RATE_LIMIT);
  if (!limited.allowed) {
    return apiError('REGISTER_RATE_LIMIT', 429);
  }

  // The account's random author key is generated here and never stored in clear.
  // Only the derived password material leaves the PasswordHasher object, and the
  // author key is wrapped under the password-derived and recovery-code-derived
  // wrap keys.
  const authorKeyHex = newAuthorKeyHex();
  const material = await derivePasswordMaterialRemote(env, usernameResult.value, password);
  const passwordHash = formatUserPasswordHash(material);
  const authorKeyPw = await wrapHex(material.wrapKeyHex, authorKeyHex);
  // Issue the first recovery code. The plaintext code is returned here only; the
  // database keeps just its hash, plus the author key wrapped under a
  // recovery-code-derived key.
  const recoveryCode = await generateRecoveryCode();
  const authorKeyRc = await wrapHex(
    await recoveryWrapKeyHex(normalizeRecoveryCode(recoveryCode.code)),
    authorKeyHex
  );
  let userId: number;
  try {
    const result = await env.DB.prepare(
      `INSERT INTO users (username, password_hash, status, recovery_code_hash, recovery_code_updated_at, author_key_pw, author_key_rc)
       VALUES (?, ?, ?, ?, unixepoch(), ?, ?)`
    ).bind(
      usernameResult.value,
      passwordHash,
      USER_STATUS_ACTIVE,
      recoveryCode.hash,
      authorKeyPw,
      authorKeyRc
    ).run();
    userId = Number(result.meta.last_row_id);
  } catch {
    return apiError('USERNAME_TAKEN', 409);
  }

  await recordAccount(env.DB, monthHash);

  const token = await createSession(env, userId, authorKeyHex);
  return noStoreJson({
    ok: true,
    user: { id: userId, username: usernameResult.value },
    recoveryCode: recoveryCode.code
  }, 201, { 'set-cookie': buildSessionCookie(token, isSecureRequest(request)) });
}

async function login(request: Request, env: HandlerEnv): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body) return apiError('INVALID_JSON', 400);

  const username = normalizeUsername(readString(body, 'username'));
  const password = readString(body, 'password');
  if (!username || !password) {
    return apiError('CREDENTIALS_REQUIRED', 400);
  }

  const turnstileError = await turnstileGate(request, env, body);
  if (turnstileError) return turnstileError;

  const ipHash = await hashedNetworkBucket(clientAddress(request), serverHmacKey(env), new Date(), 'day');
  if (!ipHash) return apiError('SERVER_NOT_CONFIGURED', 503);

  const limited = await checkRateLimit(env, 'login', ipHash, env.login_rate_limit, DEFAULT_LOGIN_RATE_LIMIT);
  if (!limited.allowed) {
    return apiError('LOGIN_RATE_LIMIT', 429);
  }

  const user = await env.DB.prepare(
    `SELECT id, username, password_hash, status, failed_attempts, locked_until, author_key_pw, created_at
     FROM users WHERE username = ?`
  ).bind(username).first<UserRow>();

  const maxFailed = Number(env.login_max_failed_attempts ?? DEFAULT_MAX_FAILED_ATTEMPTS);
  const lockMinutes = Number(env.login_lock_minutes ?? DEFAULT_LOCK_MINUTES);
  const now = Math.floor(Date.now() / 1000);

  // Every failure mode returns the same generic message so the endpoint cannot
  // confirm whether a username exists or is disabled or locked.
  if (!user || user.status !== USER_STATUS_ACTIVE || (user.locked_until !== null && user.locked_until > now)) {
    return apiError('INVALID_CREDENTIALS', 401);
  }

  // Re-derive the password material from the stored salt and iteration count and
  // compare the verifier. A row whose stored hash is not the public format is a
  // mismatch, exactly like a wrong password.
  const parsed = parseUserPasswordHash(user.password_hash);
  const material = parsed
    ? await derivePasswordMaterialRemote(env, username, password, parsed.saltHex, parsed.iterations)
    : null;
  if (!parsed || !material || !constantTimeEqual(material.verifierHex, parsed.verifierHex)) {
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
    return apiError('INVALID_CREDENTIALS', 401);
  }

  // The password is correct, so the stored wrap key recovers the author key.
  const authorKeyHex = await unwrapHex(material.wrapKeyHex, user.author_key_pw);
  if (authorKeyHex === null) {
    // A consistent row always unwraps; this guards against a corrupt row rather
    // than treating it as a wrong password.
    return apiError('ACCOUNT_KEY_UNAVAILABLE', 500);
  }

  // Rehash with the current iteration count when the stored hash predates it. The
  // author key is re-wrapped under the new password-derived key at the same time.
  const next = parsed.iterations < PBKDF2_ITERATIONS
    ? await derivePasswordMaterialRemote(env, username, password)
    : null;
  const nextHash = next ? formatUserPasswordHash(next) : null;
  const nextAuthorKeyPw = next ? await wrapHex(next.wrapKeyHex, authorKeyHex) : null;

  // last_login_at is rounded to the day so it cannot be joined against precise
  // activity timestamps. `updated_at` is written at the same day resolution: the
  // exact second here would hand back the login time the rounding just removed.
  const dayStart = now - (now % 86400);
  await env.DB.prepare(
    `UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ?, updated_at = ?,
       password_hash = COALESCE(?, password_hash), author_key_pw = COALESCE(?, author_key_pw)
     WHERE id = ?`
  ).bind(dayStart, dayStart, nextHash, nextAuthorKeyPw, user.id).run();

  const token = await createSession(env, user.id, authorKeyHex);
  const actor: UserActor = {
    id: user.id,
    username: user.username,
    createdAt: Number(user.created_at),
    authorKeyHex,
    authorMark: await authorMark(authorKeyHex)
  };
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
  if (!body) return apiError('INVALID_JSON', 400);

  const invalid = apiError('INVALID_RECOVERY_CODE', 401);

  const usernameResult = validateUsername(readString(body, 'username'));
  if (!usernameResult.ok) return invalid;

  const newPassword = readString(body, 'newPassword');
  const passwordResult = validateUserPassword(newPassword, usernameResult.value);
  if (!passwordResult.ok) return apiError(passwordResult.code, 422, { params: passwordResult.params });

  const code = normalizeRecoveryCode(readString(body, 'code'));
  if (!code) return invalid;

  const ipHash = await hashedNetworkBucket(clientAddress(request), serverHmacKey(env), new Date(), 'day');
  if (!ipHash) return apiError('SERVER_NOT_CONFIGURED', 503);

  // Recovery attempts share the login rate limit.
  const limited = await checkRateLimit(env, 'recover', ipHash, env.login_rate_limit, DEFAULT_LOGIN_RATE_LIMIT);
  if (!limited.allowed) {
    return apiError('RECOVERY_RATE_LIMIT', 429);
  }

  const user = await env.DB.prepare(
    'SELECT id, status, recovery_code_hash, author_key_rc FROM users WHERE username = ?'
  ).bind(usernameResult.value).first<{
    id: number;
    status: number;
    recovery_code_hash: string | null;
    author_key_rc: string;
  }>();
  if (!user || user.status !== USER_STATUS_ACTIVE || !user.recovery_code_hash) return invalid;

  // Check the code before deriving, so a wrong code does not pay for PBKDF2.
  const providedHash = await hashRecoveryCode(code);
  if (!constantTimeEqual(providedHash, user.recovery_code_hash)) return invalid;

  // The recovery-code-derived wrap key recovers the account's author key.
  const authorKeyHex = await unwrapHex(await recoveryWrapKeyHex(code), user.author_key_rc);
  if (authorKeyHex === null) return invalid;

  const material = await derivePasswordMaterialRemote(env, usernameResult.value, newPassword);
  const passwordHash = formatUserPasswordHash(material);
  const authorKeyPw = await wrapHex(material.wrapKeyHex, authorKeyHex);

  // Consume and rotate the code in a single statement: the WHERE clause matches
  // only the current code, which makes the update atomic (a code can never be
  // used twice) and leaves the account with a fresh code.
  const nextCode = await generateRecoveryCode();
  const authorKeyRc = await wrapHex(
    await recoveryWrapKeyHex(normalizeRecoveryCode(nextCode.code)),
    authorKeyHex
  );
  const updated = await env.DB.prepare(
    `UPDATE users
     SET password_hash = ?, author_key_pw = ?, recovery_code_hash = ?, author_key_rc = ?,
         recovery_code_updated_at = unixepoch(),
         failed_attempts = 0, locked_until = NULL, updated_at = unixepoch()
     WHERE id = ? AND recovery_code_hash = ?`
  ).bind(passwordHash, authorKeyPw, nextCode.hash, authorKeyRc, user.id, providedHash).run();
  if (Number(updated.meta.changes ?? 0) !== 1) return invalid;

  // Sign out every device so old sessions cannot outlive the reset.
  await env.DB.prepare('DELETE FROM user_sessions WHERE user_id = ?').bind(user.id).run();

  return noStoreJson({ ok: true, recoveryCode: nextCode.code });
}
