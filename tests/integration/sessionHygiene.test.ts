// Session hygiene.
//
// Session rows are hour-coarsened, a credential or privilege change revokes the
// affected sessions, and signing out everywhere drops every device. The admin
// Worker is deployed separately and has no test harness of its own, so its
// handlers are called directly against the shared D1 binding, as in
// tests/integration/adminReports.test.ts.

import { beforeAll, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { ADMIN_ROLE_ADMIN, ADMIN_ROLE_SUPER, ADMIN_STATUS_ACTIVE } from '../../admin/lib/admins';
import { handleAdminsRequest } from '../../admin/api/admins';
import { handleSessionRequest } from '../../admin/api/session';
import { handleUsersRequest } from '../../admin/api/users';
import { hashPassword } from '../../worker/services/passwordHasher';
import type { AdminActor } from '../../admin/auth';
import { ORIGIN, applySchema, lastId } from './helpers';

const ADMIN_ORIGIN = 'https://admin.example.com';
const PASSWORD = 'test-password-123';
// Auth and CSRF are enforced in admin/index.ts, not in the handlers.
const SUPER_ACTOR: AdminActor = { id: 900, username: 'super-actor', role: 'super_admin' };

beforeAll(async () => {
  await applySchema();
  // Keep the per-network account cap and the sign-in rate limit out of the way.
  await env.DB.batch([
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('max_accounts_per_ip', '20')"),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('login_rate_limit', '1000/h')")
  ]);
});

async function registerUser(username: string): Promise<{ cookie: string; recoveryCode: string }> {
  const response = await SELF.fetch(`${ORIGIN}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ username, password: PASSWORD })
  });
  expect(response.status).toBe(201);
  const body = await response.json() as { recoveryCode: string };
  return { cookie: (response.headers.get('set-cookie') ?? '').split(';')[0], recoveryCode: body.recoveryCode };
}

// A protected self-service endpoint: 401 means the session behind the cookie is
// gone, while 200 means it is still accepted.
function sessionProbe(cookie: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/user/polls?ids=1`, { headers: { origin: ORIGIN, cookie } });
}

function adminLoginRequest(username: string): Request {
  return new Request(`${ADMIN_ORIGIN}/api/admin/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD })
  });
}

function adminStatusRequest(cookie: string): Request {
  return new Request(`${ADMIN_ORIGIN}/api/admin/session`, { headers: { cookie } });
}

function adminPost(path: string, body: unknown): Request {
  return new Request(`${ADMIN_ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function adminLogin(username: string): Promise<string> {
  const response = await handleSessionRequest(adminLoginRequest(username), env);
  expect(response.status).toBe(200);
  return (response.headers.get('set-cookie') ?? '').split(';')[0];
}

async function adminSessionAlive(cookie: string): Promise<boolean> {
  const response = await handleSessionRequest(adminStatusRequest(cookie), env);
  const body = await response.json() as { authenticated: boolean };
  return body.authenticated === true;
}

async function seedAdmin(username: string, role: number): Promise<number> {
  const passwordHash = await hashPassword(env, username, PASSWORD);
  await env.DB.prepare(
    'INSERT INTO admin_users (username, password_hash, role, status) VALUES (?, ?, ?, ?)'
  ).bind(username, passwordHash, role, ADMIN_STATUS_ACTIVE).run();
  return lastId();
}

describe('user session hygiene', () => {
  it('signs out earlier sessions when the password is recovered', async () => {
    const { cookie, recoveryCode } = await registerUser('recovery-user');
    expect((await sessionProbe(cookie)).status).toBe(200);

    const recovered = await SELF.fetch(`${ORIGIN}/api/auth/recover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ username: 'recovery-user', code: recoveryCode, newPassword: 'a-fresh-password-456' })
    });
    expect(recovered.status).toBe(200);

    // The session that was open before the reset is gone.
    expect((await sessionProbe(cookie)).status).toBe(401);
  });

  it('signs out every device and clears the cookie that asked for it', async () => {
    const first = await registerUser('multi-device-user');
    const login = await SELF.fetch(`${ORIGIN}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ username: 'multi-device-user', password: PASSWORD })
    });
    expect(login.status).toBe(200);
    const secondCookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    expect((await sessionProbe(secondCookie)).status).toBe(200);

    const revoked = await SELF.fetch(`${ORIGIN}/api/user/logout-all`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie: secondCookie }
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({ ok: true, revoked: true });
    // The calling browser is signed out as well.
    expect(revoked.headers.get('set-cookie') ?? '').toContain('Max-Age=0');
    expect((await sessionProbe(secondCookie)).status).toBe(401);
    expect((await sessionProbe(first.cookie)).status).toBe(401);
  });

  it('rejects the old cookie once an admin disables the account', async () => {
    const { cookie } = await registerUser('disabled-user');
    expect((await sessionProbe(cookie)).status).toBe(200);

    const row = await env.DB.prepare('SELECT id FROM users WHERE username = ?')
      .bind('disabled-user').first<{ id: number }>();
    const userId = Number(row?.id);
    const response = await handleUsersRequest(
      adminPost(`/api/admin/users/${userId}/status`, { status: 'disabled' }),
      new URL(`${ADMIN_ORIGIN}/api/admin/users/${userId}/status`),
      env,
      SUPER_ACTOR
    );
    expect(response.status).toBe(200);

    expect((await sessionProbe(cookie)).status).toBe(401);
  });
});

describe('admin session hygiene', () => {
  it('ends the target admin session when the password is reset', async () => {
    const adminId = await seedAdmin('reset-target', ADMIN_ROLE_ADMIN);
    const cookie = await adminLogin('reset-target');
    expect(await adminSessionAlive(cookie)).toBe(true);

    const response = await handleAdminsRequest(
      adminPost(`/api/admin/admins/${adminId}/password`, { password: 'another-password-789' }),
      new URL(`${ADMIN_ORIGIN}/api/admin/admins/${adminId}/password`),
      env,
      SUPER_ACTOR
    );
    expect(response.status).toBe(200);
    expect(await adminSessionAlive(cookie)).toBe(false);

    const audit = await env.DB.prepare(
      "SELECT details FROM admin_audit_log WHERE action = 'admin.password_reset' ORDER BY id DESC LIMIT 1"
    ).first<{ details: string }>();
    expect(JSON.parse(audit?.details ?? '{}')).toMatchObject({ sessionsRevoked: true });
  });

  it('replaces the previous session when an admin signs in again', async () => {
    await seedAdmin('single-session-admin', ADMIN_ROLE_ADMIN);
    const first = await adminLogin('single-session-admin');
    expect(await adminSessionAlive(first)).toBe(true);

    const second = await adminLogin('single-session-admin');
    expect(await adminSessionAlive(second)).toBe(true);
    // Single-session policy: the first login no longer works.
    expect(await adminSessionAlive(first)).toBe(false);
  });

  it('revokes the target sessions when an admin role changes', async () => {
    const adminId = await seedAdmin('role-target', ADMIN_ROLE_ADMIN);
    const cookie = await adminLogin('role-target');
    expect(await adminSessionAlive(cookie)).toBe(true);

    const response = await handleAdminsRequest(
      adminPost(`/api/admin/admins/${adminId}/role`, { role: 'super_admin' }),
      new URL(`${ADMIN_ORIGIN}/api/admin/admins/${adminId}/role`),
      env,
      SUPER_ACTOR
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, sessionsRevoked: true });
    expect(await adminSessionAlive(cookie)).toBe(false);

    const row = await env.DB.prepare('SELECT role FROM admin_users WHERE id = ?')
      .bind(adminId).first<{ role: number }>();
    expect(Number(row?.role)).toBe(ADMIN_ROLE_SUPER);

    const audit = await env.DB.prepare(
      "SELECT details FROM admin_audit_log WHERE action = 'admin.role' ORDER BY id DESC LIMIT 1"
    ).first<{ details: string }>();
    expect(JSON.parse(audit?.details ?? '{}')).toMatchObject({ sessionsRevoked: true });
  });

  it('stores hour-resolution created_at in both session tables', async () => {
    await registerUser('coarse-user');
    const userRow = await env.DB.prepare(
      'SELECT created_at FROM user_sessions ORDER BY created_at DESC LIMIT 1'
    ).first<{ created_at: number }>();
    expect(Number(userRow?.created_at) % 3600).toBe(0);

    const adminId = await seedAdmin('coarse-admin', ADMIN_ROLE_ADMIN);
    await adminLogin('coarse-admin');
    const adminRow = await env.DB.prepare(
      'SELECT created_at FROM admin_sessions WHERE admin_user_id = ?'
    ).bind(adminId).first<{ created_at: number }>();
    expect(Number(adminRow?.created_at) % 3600).toBe(0);
  });
});
