// Admin account constants and validation shared by the Worker and the CLI.

export const ADMIN_STATUS_ACTIVE = 1;
export const ADMIN_STATUS_DISABLED = 2;

export type AdminStatus = 'active' | 'disabled';

// Roles: the first admin is a super admin; later admins are regular admins until
// a super admin explicitly grants the super admin role.
export const ADMIN_ROLE_ADMIN = 1;
export const ADMIN_ROLE_SUPER = 2;

export type AdminRole = 'admin' | 'super_admin';

export function adminRoleLabel(value: number): AdminRole {
  return value === ADMIN_ROLE_SUPER ? 'super_admin' : 'admin';
}

export function adminRoleCode(value: string): number | null {
  if (value === 'admin') return ADMIN_ROLE_ADMIN;
  if (value === 'super_admin') return ADMIN_ROLE_SUPER;
  return null;
}

export function isSuperAdminRole(value: number): boolean {
  return value === ADMIN_ROLE_SUPER;
}

// Five failed logins lock the account for fifteen minutes.
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_DURATION_SECONDS = 15 * 60;

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;

export function adminStatusLabel(value: number): AdminStatus {
  return value === ADMIN_STATUS_DISABLED ? 'disabled' : 'active';
}

export function adminStatusCode(value: string): number | null {
  if (value === 'active') return ADMIN_STATUS_ACTIVE;
  if (value === 'disabled') return ADMIN_STATUS_DISABLED;
  return null;
}

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function validateUsername(value: string): { ok: true; value: string } | { ok: false; error: string } {
  const normalized = normalizeUsername(value);
  if (!USERNAME_PATTERN.test(normalized)) {
    return {
      ok: false,
      error: `username must be ${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH} lowercase characters (letters, digits, dot, underscore, hyphen)`
    };
  }
  return { ok: true, value: normalized };
}
