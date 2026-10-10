// Admin user management: list, create, password reset, lock reset, and status.

import type { AdminActor, AdminEnv } from '../auth';
import {
  ADMIN_ROLE_ADMIN,
  ADMIN_ROLE_SUPER,
  ADMIN_STATUS_ACTIVE,
  adminRoleCode,
  adminRoleLabel,
  adminStatusCode,
  adminStatusLabel,
  validateUsername
} from '../lib/admins';
import { logAudit } from '../lib/audit';
import { noStoreJson, readJsonBody, readString } from '../lib/http';
import { hashPassword, validatePassword } from '../lib/password';

interface AdminUserRow {
  id: number;
  username: string;
  role: number;
  status: number;
  failed_attempts: number;
  locked_until: number | null;
  last_login_at: number | null;
  created_at: number;
  updated_at: number;
}

function isSuper(actor: AdminActor): boolean {
  return actor.role === 'super_admin';
}

export async function handleAdminsRequest(
  request: Request,
  url: URL,
  env: AdminEnv,
  actor: AdminActor
): Promise<Response> {
  const match = url.pathname.match(/^\/api\/admin\/admins(?:\/(\d+)(?:\/(password|status|unlock))?)?$/);
  if (!match) return noStoreJson({ message: 'not found' }, 404);

  const [, idText, action] = match;

  if (!idText) {
    if (request.method === 'GET') return listAdmins(env);
    if (request.method === 'POST') return createAdmin(request, env, actor);
    return noStoreJson({ message: 'method not allowed' }, 405);
  }

  const adminId = Number(idText);
  if (!Number.isSafeInteger(adminId) || adminId < 1) {
    return noStoreJson({ message: 'invalid admin ID' }, 400);
  }

  if (!action && request.method === 'DELETE') {
    return deleteAdmin(adminId, env, actor);
  }
  if (request.method !== 'POST') {
    return noStoreJson({ message: 'method not allowed' }, 405);
  }
  if (action === 'unlock') return unlockAdmin(adminId, env, actor);
  if (action === 'password') return resetPassword(adminId, request, env, actor);
  if (action === 'status') return updateStatus(adminId, request, env, actor);
  return noStoreJson({ message: 'not found' }, 404);
}

async function listAdmins(env: AdminEnv): Promise<Response> {
  const result = await env.DB.prepare(
    `SELECT id, username, role, status, failed_attempts, locked_until, last_login_at, created_at, updated_at
     FROM admin_users ORDER BY id ASC`
  ).all<AdminUserRow>();

  return noStoreJson({
    admins: (result.results ?? []).map(serializeAdmin)
  });
}

async function activeAdminCount(env: AdminEnv): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS total FROM admin_users WHERE status = ?'
  ).bind(ADMIN_STATUS_ACTIVE).first<{ total: number }>();
  return Number(row?.total ?? 0);
}

async function activeSuperAdminCount(env: AdminEnv): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS total FROM admin_users WHERE status = ? AND role = ?'
  ).bind(ADMIN_STATUS_ACTIVE, ADMIN_ROLE_SUPER).first<{ total: number }>();
  return Number(row?.total ?? 0);
}

async function createAdmin(request: Request, env: AdminEnv, actor: AdminActor): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body) return noStoreJson({ message: 'invalid JSON' }, 400);

  const usernameResult = validateUsername(readString(body, 'username'));
  if (!usernameResult.ok) return noStoreJson({ message: usernameResult.error }, 422);

  const password = readString(body, 'password');
  const passwordResult = validatePassword(password);
  if (!passwordResult.ok) return noStoreJson({ message: passwordResult.error }, 422);

  const requestedRole = readString(body, 'role');
  let roleCode = ADMIN_ROLE_ADMIN;
  if (requestedRole) {
    const parsed = adminRoleCode(requestedRole);
    if (parsed === null) {
      return noStoreJson({ message: 'role must be "admin" or "super_admin"' }, 422);
    }
    if (parsed === ADMIN_ROLE_SUPER && !isSuper(actor)) {
      return noStoreJson({ message: 'only a super admin can create a super admin' }, 403);
    }
    roleCode = parsed;
  }

  const existing = await env.DB.prepare(
    'SELECT id FROM admin_users WHERE username = ?'
  ).bind(usernameResult.value).first<{ id: number }>();
  if (existing) {
    return noStoreJson({ message: 'username already exists' }, 409);
  }

  const passwordHash = await hashPassword(password);
  const result = await env.DB.prepare(
    'INSERT INTO admin_users (username, password_hash, role) VALUES (?, ?, ?)'
  ).bind(usernameResult.value, passwordHash, roleCode).run();

  const adminId = Number(result.meta.last_row_id);
  await logAudit(env, {
    actor, action: 'admin.create', targetType: 'admin_user', targetId: adminId,
    details: { username: usernameResult.value, role: adminRoleLabel(roleCode) }
  });

  return noStoreJson({
    ok: true,
    admin: { id: adminId, username: usernameResult.value, role: adminRoleLabel(roleCode) }
  }, 201);
}

async function findAdmin(env: AdminEnv, adminId: number): Promise<AdminUserRow | null> {
  return env.DB.prepare(
    `SELECT id, username, role, status, failed_attempts, locked_until, last_login_at, created_at, updated_at
     FROM admin_users WHERE id = ?`
  ).bind(adminId).first<AdminUserRow>();
}

// Clears the failed-attempt counter and the lock expiry for an admin user.
async function unlockAdmin(adminId: number, env: AdminEnv, actor: AdminActor): Promise<Response> {
  const admin = await findAdmin(env, adminId);
  if (!admin) return noStoreJson({ message: `admin ${adminId} was not found` }, 404);

  await env.DB.prepare(
    'UPDATE admin_users SET failed_attempts = 0, locked_until = NULL, updated_at = unixepoch() WHERE id = ?'
  ).bind(adminId).run();

  await logAudit(env, {
    actor, action: 'admin.unlock', targetType: 'admin_user', targetId: adminId,
    details: { username: admin.username }
  });

  return noStoreJson({ ok: true, message: `Unlocked ${admin.username}.` });
}

async function resetPassword(
  adminId: number,
  request: Request,
  env: AdminEnv,
  actor: AdminActor
): Promise<Response> {
  const admin = await findAdmin(env, adminId);
  if (!admin) return noStoreJson({ message: `admin ${adminId} was not found` }, 404);
  if (admin.role === ADMIN_ROLE_SUPER && !isSuper(actor)) {
    return noStoreJson({ message: 'only a super admin can reset a super admin password' }, 403);
  }

  const body = await readJsonBody(request);
  if (!body) return noStoreJson({ message: 'invalid JSON' }, 400);

  const password = readString(body, 'password');
  const passwordResult = validatePassword(password);
  if (!passwordResult.ok) return noStoreJson({ message: passwordResult.error }, 422);

  const passwordHash = await hashPassword(password);
  await env.DB.prepare(
    `UPDATE admin_users
     SET password_hash = ?, failed_attempts = 0, locked_until = NULL, updated_at = unixepoch()
     WHERE id = ?`
  ).bind(passwordHash, adminId).run();

  // Invalidate any existing sessions for the account.
  await env.DB.prepare('DELETE FROM admin_sessions WHERE admin_user_id = ?').bind(adminId).run();

  await logAudit(env, {
    actor, action: 'admin.password_reset', targetType: 'admin_user', targetId: adminId,
    details: { username: admin.username }
  });

  return noStoreJson({ ok: true, message: `Password reset for ${admin.username}.` });
}

async function updateStatus(
  adminId: number,
  request: Request,
  env: AdminEnv,
  actor: AdminActor
): Promise<Response> {
  const admin = await findAdmin(env, adminId);
  if (!admin) return noStoreJson({ message: `admin ${adminId} was not found` }, 404);
  if (admin.role === ADMIN_ROLE_SUPER && !isSuper(actor)) {
    return noStoreJson({ message: 'only a super admin can change a super admin' }, 403);
  }

  const body = await readJsonBody(request);
  if (!body) return noStoreJson({ message: 'invalid JSON' }, 400);

  const statusValue = adminStatusCode(readString(body, 'status'));
  if (statusValue === null) {
    return noStoreJson({ message: 'status must be "active" or "disabled"' }, 422);
  }

  if (statusValue === admin.status) {
    return noStoreJson({ ok: true, message: `Admin ${admin.username} is already ${adminStatusLabel(statusValue)}.` });
  }
  if (adminId === actor.id) {
    return noStoreJson({ message: 'you cannot change your own status' }, 409);
  }
  if (admin.status === ADMIN_STATUS_ACTIVE && statusValue !== ADMIN_STATUS_ACTIVE
    && await activeAdminCount(env) <= 1) {
    return noStoreJson({ message: 'at least one active admin is required' }, 409);
  }
  if (admin.role === ADMIN_ROLE_SUPER && admin.status === ADMIN_STATUS_ACTIVE
    && statusValue !== ADMIN_STATUS_ACTIVE && await activeSuperAdminCount(env) <= 1) {
    return noStoreJson({ message: 'at least one active super admin is required' }, 409);
  }

  await env.DB.prepare(
    'UPDATE admin_users SET status = ?, updated_at = unixepoch() WHERE id = ?'
  ).bind(statusValue, adminId).run();

  if (statusValue !== ADMIN_STATUS_ACTIVE) {
    await env.DB.prepare('DELETE FROM admin_sessions WHERE admin_user_id = ?').bind(adminId).run();
  }

  await logAudit(env, {
    actor, action: 'admin.status', targetType: 'admin_user', targetId: adminId,
    details: { username: admin.username, status: adminStatusLabel(statusValue) }
  });

  return noStoreJson({ ok: true, message: `Admin ${admin.username} is now ${adminStatusLabel(statusValue)}.` });
}

async function deleteAdmin(adminId: number, env: AdminEnv, actor: AdminActor): Promise<Response> {
  const admin = await findAdmin(env, adminId);
  if (!admin) return noStoreJson({ message: `admin ${adminId} was not found` }, 404);
  if (admin.role === ADMIN_ROLE_SUPER && !isSuper(actor)) {
    return noStoreJson({ message: 'only a super admin can delete a super admin' }, 403);
  }
  if (adminId === actor.id) {
    return noStoreJson({ message: 'you cannot delete your own account' }, 409);
  }
  if (await activeAdminCount(env) <= 1 && admin.status === ADMIN_STATUS_ACTIVE) {
    return noStoreJson({ message: 'at least one active admin is required' }, 409);
  }
  if (admin.role === ADMIN_ROLE_SUPER && admin.status === ADMIN_STATUS_ACTIVE
    && await activeSuperAdminCount(env) <= 1) {
    return noStoreJson({ message: 'at least one active super admin is required' }, 409);
  }

  await env.DB.batch([
    env.DB.prepare('DELETE FROM admin_sessions WHERE admin_user_id = ?').bind(adminId),
    env.DB.prepare('DELETE FROM admin_users WHERE id = ?').bind(adminId)
  ]);

  await logAudit(env, {
    actor, action: 'admin.delete', targetType: 'admin_user', targetId: adminId,
    details: { username: admin.username }
  });

  return noStoreJson({ ok: true, message: `Deleted ${admin.username}.` });
}

function serializeAdmin(row: AdminUserRow) {
  return {
    id: row.id,
    username: row.username,
    role: adminRoleLabel(row.role),
    status: adminStatusLabel(row.status),
    failedAttempts: Number(row.failed_attempts),
    lockedUntil: row.locked_until ? new Date(row.locked_until * 1000).toISOString() : null,
    isLocked: row.locked_until !== null && row.locked_until * 1000 > Date.now(),
    lastLoginAt: row.last_login_at ? new Date(row.last_login_at * 1000).toISOString() : null,
    createdAt: new Date(row.created_at * 1000).toISOString(),
    updatedAt: new Date(row.updated_at * 1000).toISOString()
  };
}
