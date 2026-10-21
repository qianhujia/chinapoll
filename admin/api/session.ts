// Session endpoints: login, logout, status, and first-run setup.

import {
  buildClearSessionCookie,
  buildSessionCookie,
  createSession,
  destroySession,
  getSessionContext,
  type AdminActor,
  type AdminEnv
} from '../auth';
import {
  ADMIN_STATUS_ACTIVE,
  ADMIN_ROLE_SUPER,
  adminRoleLabel,
  LOCK_DURATION_SECONDS,
  MAX_FAILED_ATTEMPTS,
  normalizeUsername,
  validateUsername
} from '../lib/admins';
import { logAudit } from '../lib/audit';
import { noStoreJson, readJsonBody, readString } from '../../shared/http';
import { PBKDF2_ITERATIONS, passwordIterations, validatePassword } from '../../shared/password';
import { hashPassword, verifyPassword } from '../../worker/services/passwordHasher';
import { getTurnstileConfig, verifyAdminTurnstile } from '../services/turnstile';
import { checkRateLimit } from '../../worker/services/rateLimit';

// Admin login is rate limited per username through the shared RateLimiter
// Durable Object. There is no global limiter: a global counter would let anyone
// lock every admin out with a burst of bad requests. Turnstile, when enabled,
// provides the cross-cutting guard instead.
const LOGIN_USER_LIMIT = '10/m';
const SETUP_LIMIT = '3/m';

async function enforceLoginRateLimit(env: AdminEnv, username: string): Promise<Response | null> {
  const perUser = await checkRateLimit(env, 'admin-login-user', `user:${username}`, LOGIN_USER_LIMIT, LOGIN_USER_LIMIT);
  if (!perUser.allowed) return noStoreJson({ message: 'too many login attempts; try again later' }, 429);
  return null;
}

interface AdminUserRow {
  id: number;
  username: string;
  password_hash: string;
  status: number;
  failed_attempts: number;
  locked_until: number | null;
  role: number;
}

function isSecure(request: Request): boolean {
  return new URL(request.url).protocol === 'https:';
}

async function countAdmins(env: AdminEnv): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS total FROM admin_users').first<{ total: number }>();
  return Number(row?.total ?? 0);
}

export async function handleSessionRequest(request: Request, env: AdminEnv): Promise<Response> {
  if (request.method === 'GET') return sessionStatus(request, env);
  if (request.method === 'POST') return login(request, env);
  if (request.method === 'DELETE') return logout(request, env);
  return noStoreJson({ message: 'method not allowed' }, 405);
}

async function sessionStatus(request: Request, env: AdminEnv): Promise<Response> {
  const [context, turnstile, adminCount] = await Promise.all([
    getSessionContext(request, env),
    getTurnstileConfig(env),
    countAdmins(env)
  ]);

  return noStoreJson({
    authenticated: context !== null,
    user: context ? context.actor : null,
    setupRequired: adminCount === 0,
    turnstile: { enabled: turnstile.enabled, siteKey: turnstile.siteKey },
    publicSiteOrigin: env.PUBLIC_SITE_ORIGIN ?? ''
  });
}

async function logout(request: Request, env: AdminEnv): Promise<Response> {
  const context = await getSessionContext(request, env);
  if (context) {
    await destroySession(env, context.token);
    await logAudit(env, { actor: context.actor, action: 'logout' });
  }
  return noStoreJson({ ok: true }, 200, { 'set-cookie': buildClearSessionCookie(isSecure(request)) });
}

async function login(request: Request, env: AdminEnv): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body) return noStoreJson({ message: 'invalid JSON' }, 400);

  const username = normalizeUsername(readString(body, 'username'));
  const password = readString(body, 'password');
  const turnstileToken = readString(body, 'turnstileToken');
  if (!username || !password) {
    return noStoreJson({ message: 'username and password are required' }, 400);
  }

  const turnstile = getTurnstileConfig(env);
  if (turnstile.enabled) {
    if (!turnstileToken) {
      return noStoreJson({ message: 'turnstile verification required' }, 403);
    }
    if (!await verifyAdminTurnstile(env, turnstileToken, new URL(request.url).hostname)) {
      return noStoreJson({ message: 'turnstile verification failed' }, 403);
    }
  }

  const rateLimited = await enforceLoginRateLimit(env, username);
  if (rateLimited) return rateLimited;

  const user = await env.DB.prepare(
    `SELECT id, username, password_hash, status, failed_attempts, locked_until, role
     FROM admin_users WHERE username = ?`
  ).bind(username).first<AdminUserRow>();

  // Every failure mode returns the same generic message so the endpoint cannot
  // confirm whether a username exists, is disabled, or is locked.
  if (!user || user.status !== ADMIN_STATUS_ACTIVE) {
    await logAudit(env, { action: 'login.failed', actorUsername: username, details: { reason: user ? 'unavailable' : 'unknown_user' } });
    return noStoreJson({ message: 'invalid username or password' }, 401);
  }

  const now = Math.floor(Date.now() / 1000);
  if (user.locked_until && user.locked_until > now) {
    await logAudit(env, {
      action: 'login.locked', actorUsername: username,
      targetType: 'admin_user', targetId: user.id
    });
    return noStoreJson({ message: 'invalid username or password' }, 401);
  }

  if (!await verifyPassword(env, username, password, user.password_hash)) {
    const attempts = user.failed_attempts + 1;
    if (attempts >= MAX_FAILED_ATTEMPTS) {
      const lockedUntil = now + LOCK_DURATION_SECONDS;
      await env.DB.prepare(
        'UPDATE admin_users SET failed_attempts = 0, locked_until = ?, updated_at = unixepoch() WHERE id = ?'
      ).bind(lockedUntil, user.id).run();
      await logAudit(env, {
        action: 'login.locked', actorUsername: username,
        targetType: 'admin_user', targetId: user.id,
        details: { reason: 'too_many_attempts', lockedUntil: new Date(lockedUntil * 1000).toISOString() }
      });
      return noStoreJson({ message: 'invalid username or password' }, 401);
    }

    await env.DB.prepare(
      'UPDATE admin_users SET failed_attempts = ?, updated_at = unixepoch() WHERE id = ?'
    ).bind(attempts, user.id).run();
    await logAudit(env, {
      action: 'login.failed', actorUsername: username,
      targetType: 'admin_user', targetId: user.id,
      details: { attempts }
    });
    return noStoreJson({ message: 'invalid username or password' }, 401);
  }

  // Rehash with the current iteration count when the stored hash predates it.
  const storedIterations = passwordIterations(user.password_hash);
  const nextHash = storedIterations !== null && storedIterations < PBKDF2_ITERATIONS
    ? await hashPassword(env, username, password)
    : null;

  await env.DB.prepare(
    `UPDATE admin_users
     SET failed_attempts = 0, locked_until = NULL, last_login_at = unixepoch(), updated_at = unixepoch(),
         password_hash = COALESCE(?, password_hash)
     WHERE id = ?`
  ).bind(nextHash, user.id).run();

  const token = await createSession(env, user.id);
  const actor: AdminActor = { id: user.id, username: user.username, role: adminRoleLabel(user.role) };
  await logAudit(env, { actor, action: 'login.success' });

  return noStoreJson({ ok: true, user: actor }, 200, {
    'set-cookie': buildSessionCookie(token, isSecure(request))
  });
}

// Creates the very first admin user as a super admin. Disabled once any admin
// user exists.
async function setup(request: Request, env: AdminEnv): Promise<Response> {
  const setupLimit = await checkRateLimit(env, 'admin-setup', 'global:setup', SETUP_LIMIT, SETUP_LIMIT);
  if (!setupLimit.allowed) {
    return noStoreJson({ message: 'too many setup attempts; try again later' }, 429);
  }

  const body = await readJsonBody(request);
  if (!body) return noStoreJson({ message: 'invalid JSON' }, 400);

  if (await countAdmins(env) > 0) {
    return noStoreJson({ message: 'setup already completed' }, 409);
  }

  const usernameResult = validateUsername(readString(body, 'username'));
  if (!usernameResult.ok) return noStoreJson({ message: usernameResult.error }, 422);

  const password = readString(body, 'password');
  const passwordResult = validatePassword(password);
  if (!passwordResult.ok) return noStoreJson({ message: passwordResult.error }, 422);

  const passwordHash = await hashPassword(env, usernameResult.value, password);
  const result = await env.DB.prepare(
    'INSERT INTO admin_users (username, password_hash, role) VALUES (?, ?, ?)'
  ).bind(usernameResult.value, passwordHash, ADMIN_ROLE_SUPER).run();

  const adminId = Number(result.meta.last_row_id);
  await logAudit(env, {
    action: 'admin.setup',
    actorUsername: usernameResult.value,
    targetType: 'admin_user',
    targetId: adminId,
    details: { role: 'super_admin' }
  });

  return noStoreJson({
    ok: true,
    user: { id: adminId, username: usernameResult.value, role: 'super_admin' }
  }, 201);
}

export async function handleSetupRequest(request: Request, env: AdminEnv): Promise<Response> {
  if (request.method !== 'POST') {
    return noStoreJson({ message: 'method not allowed' }, 405);
  }
  return setup(request, env);
}
