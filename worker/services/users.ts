// Public user account constants and validation shared by the Worker.

import { errorMessage, type ApiErrorCode, type ApiErrorParams } from '../../shared/errors';

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

export const USER_PASSWORD_MIN_LENGTH = 12;
export const USER_PASSWORD_MAX_LENGTH = 200;

export type UsernameValidation =
  | { ok: true; value: string }
  | { ok: false; code: ApiErrorCode; params: ApiErrorParams; error: string };
export type PasswordValidation =
  | { ok: true }
  | { ok: false; code: ApiErrorCode; params: ApiErrorParams; error: string };

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function validateUsername(value: string): UsernameValidation {
  const normalized = normalizeUsername(value);
  if (!USERNAME_PATTERN.test(normalized)) {
    const params = { min: USERNAME_MIN_LENGTH, max: USERNAME_MAX_LENGTH };
    // The code carries the rule and its values; `error` keeps the English text
    // older clients read.
    return { ok: false, code: 'USERNAME_INVALID', params, error: errorMessage('USERNAME_INVALID', params) };
  }
  return { ok: true, value: normalized };
}

export function validateUserPassword(password: string, username = ''): PasswordValidation {
  if (password.length < USER_PASSWORD_MIN_LENGTH) {
    const params = { min: USER_PASSWORD_MIN_LENGTH };
    return { ok: false, code: 'PASSWORD_TOO_SHORT', params, error: errorMessage('PASSWORD_TOO_SHORT', params) };
  }
  if (password.length > USER_PASSWORD_MAX_LENGTH) {
    const params = { max: USER_PASSWORD_MAX_LENGTH };
    return { ok: false, code: 'PASSWORD_TOO_LONG', params, error: errorMessage('PASSWORD_TOO_LONG', params) };
  }
  // A password that equals the username is trivially guessable.
  if (username && password.toLowerCase() === username.toLowerCase()) {
    return { ok: false, code: 'PASSWORD_SAME_AS_USERNAME', params: {}, error: errorMessage('PASSWORD_SAME_AS_USERNAME') };
  }
  return { ok: true };
}

export interface AccountAge {
  allowed: boolean;
  /** Whole minutes still required before the action is allowed (0 when allowed). */
  remainingMinutes: number;
}

// New accounts must wait a configurable delay before submitting polls or
// comments. `createdAt` is unix seconds and `delayMinutes` is the configured
// wait in whole minutes.
export function checkAccountAge(createdAt: number, delayMinutes: number, nowSeconds = Math.floor(Date.now() / 1000)): AccountAge {
  const requiredSeconds = Math.max(0, delayMinutes) * 60;
  const elapsedSeconds = nowSeconds - createdAt;
  if (elapsedSeconds >= requiredSeconds) {
    return { allowed: true, remainingMinutes: 0 };
  }
  return { allowed: false, remainingMinutes: Math.ceil((requiredSeconds - elapsedSeconds) / 60) };
}
