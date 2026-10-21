// PBKDF2-HMAC-SHA256 password derivation shared by both Workers.
//
// These are the raw primitives. Production callers must not use them directly:
// every password hash is produced and checked by the PasswordHasher Durable
// Object (worker/services/passwordHasher.ts), which calls the functions here so
// the CPU-heavy derivation runs off the request Worker's CPU path.
//
// Storage format: "pbkdf2$<iterations>$<salt-hex>$<hash-hex>". The iteration
// count is part of the stored value, so hashes created with an older (lower)
// count still verify; callers rehash on successful sign-in when they see one.

import { constantTimeEqual, fromHex, toHex } from './crypto';

// 100k iterations is the maximum Cloudflare's production WebCrypto accepts for
// PBKDF2 (higher counts throw NotSupportedError). It is below the OWASP guidance
// for PBKDF2-HMAC-SHA256, but production cannot derive a stronger hash with the
// built-in primitive.
export const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

// Admin and public passwords share the same minimum length rule.
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 200;

export type PasswordValidation = { ok: true } | { ok: false; error: string };

export function validatePassword(password: string, username = ''): PasswordValidation {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return { ok: false, error: `password must be at least ${PASSWORD_MIN_LENGTH} characters` };
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return { ok: false, error: `password must not exceed ${PASSWORD_MAX_LENGTH} characters` };
  }
  // A password that equals the username is trivially guessable.
  if (username && password.toLowerCase() === username.toLowerCase()) {
    return { ok: false, error: 'password must not be the same as the username' };
  }
  return { ok: true };
}

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    HASH_BITS
  );
  return toHex(new Uint8Array(bits));
}

export async function derivePasswordHash(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = new Uint8Array(new ArrayBuffer(SALT_BYTES));
  crypto.getRandomValues(salt);
  const hash = await derive(password, salt, iterations);
  return `pbkdf2$${iterations}$${toHex(salt)}$${hash}`;
}

// Returns the stored iteration count, or null when the value is not a
// well-formed PBKDF2 hash.
export function passwordIterations(stored: string): number | null {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return null;
  const iterations = Number(parts[1]);
  if (!Number.isSafeInteger(iterations) || iterations < 10_000) return null;
  return iterations;
}

export async function checkPasswordHash(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isSafeInteger(iterations) || iterations < 10_000) return false;
  const salt = fromHex(parts[2]);
  if (salt.length === 0) return false;
  const hash = await derive(password, salt, iterations);
  return constantTimeEqual(hash, parts[3]);
}