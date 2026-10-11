// Public user account constants and validation shared by the Worker.

export const USER_STATUS_ACTIVE = 1;
export const USER_STATUS_DISABLED = 2;

export type UserStatus = 'active' | 'disabled';

export function userStatusLabel(value: number): UserStatus {
  return value === USER_STATUS_DISABLED ? 'disabled' : 'active';
}

export function userStatusCode(value: string): number | null {
  if (value === 'active') return USER_STATUS_ACTIVE;
  if (value === 'disabled') return USER_STATUS_DISABLED;
  return null;
}

// Usernames are stored lowercase and mirror the admin rules so both account
// types behave the same way.
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;

export const USER_PASSWORD_MIN_LENGTH = 8;
export const USER_PASSWORD_MAX_LENGTH = 200;

export type UsernameValidation = { ok: true; value: string } | { ok: false; error: string };
export type PasswordValidation = { ok: true } | { ok: false; error: string };

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function validateUsername(value: string): UsernameValidation {
  const normalized = normalizeUsername(value);
  if (!USERNAME_PATTERN.test(normalized)) {
    return {
      ok: false,
      error: `username must be ${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH} lowercase characters (letters, digits, dot, underscore, hyphen)`
    };
  }
  return { ok: true, value: normalized };
}

export function validateUserPassword(password: string): PasswordValidation {
  if (password.length < USER_PASSWORD_MIN_LENGTH) {
    return { ok: false, error: `password must be at least ${USER_PASSWORD_MIN_LENGTH} characters` };
  }
  if (password.length > USER_PASSWORD_MAX_LENGTH) {
    return { ok: false, error: `password must not exceed ${USER_PASSWORD_MAX_LENGTH} characters` };
  }
  return { ok: true };
}

export interface AccountAge {
  allowed: boolean;
  /** Whole hours still required before the action is allowed (0 when allowed). */
  remainingHours: number;
}

// New accounts must wait a configurable delay before submitting polls or
// comments. `createdAt` is unix seconds.
export function checkAccountAge(createdAt: number, delayHours: number, nowSeconds = Math.floor(Date.now() / 1000)): AccountAge {
  const requiredSeconds = Math.max(0, delayHours) * 60 * 60;
  const elapsedSeconds = nowSeconds - createdAt;
  if (elapsedSeconds >= requiredSeconds) {
    return { allowed: true, remainingHours: 0 };
  }
  return { allowed: false, remainingHours: Math.ceil((requiredSeconds - elapsedSeconds) / 3600) };
}
