// PBKDF2 password hashing for public user accounts.
//
// The implementation lives in shared/password.ts so the public and admin Workers
// use one copy. This module re-exports it for the existing imports.

export {
  PBKDF2_ITERATIONS,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  hashPassword,
  passwordIterations,
  validatePassword,
  verifyPassword,
  type PasswordValidation
} from '../../shared/password';
