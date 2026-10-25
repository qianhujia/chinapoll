// PBKDF2-HMAC-SHA256 password derivation shared by both Workers.
//
// These are the raw primitives. Production callers must not use them directly:
// every password hash is produced and checked by the PasswordHasher Durable
// Object (worker/services/passwordHasher.ts), which calls the functions here so
// the CPU-heavy derivation runs off the request Worker's CPU path.
//
// Two stored formats exist:
//   * Admin accounts: "pbkdf2$<iterations>$<salt-hex>$<hash-hex>".
//   * Public accounts: "pbkdf2w$<iterations>$<salt-hex>$<verifier-hex>", where
//     the PBKDF2 output is split into a "verifier" (checked at sign-in) and a
//     "wrap" key (used to wrap the account's author key).
// The iteration count is part of the stored value, so hashes created with an
// older (lower) count still verify; callers rehash on successful sign-in when
// they see one.

import { constantTimeEqual, deriveKey, fromHex, toHex } from './crypto';

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

// The password-derived material for a public account. `verifierHex` proves the
// password at sign-in; `wrapKeyHex` unwraps the account's stored author key.
// Both are derived from the PBKDF2 output `M`, which itself never leaves the
// PasswordHasher Durable Object.
export interface PasswordMaterial {
  saltHex: string;
  iterations: number;
  verifierHex: string;
  wrapKeyHex: string;
}

// Derives the public-account password material. When `saltHex` is omitted a
// fresh 16-byte salt is generated; passing the stored salt re-derives the same
// material for a sign-in check.
export async function derivePasswordMaterial(
  password: string,
  saltHex?: string,
  iterations = PBKDF2_ITERATIONS
): Promise<PasswordMaterial> {
  let salt: Uint8Array<ArrayBuffer>;
  if (saltHex === undefined) {
    salt = new Uint8Array(new ArrayBuffer(SALT_BYTES));
    crypto.getRandomValues(salt);
  } else {
    salt = fromHex(saltHex);
  }
  const master = await derive(password, salt, iterations);
  return {
    saltHex: toHex(salt),
    iterations,
    verifierHex: await deriveKey(master, 'verifier'),
    wrapKeyHex: await deriveKey(master, 'wrap')
  };
}

export function formatUserPasswordHash(material: PasswordMaterial): string {
  return `pbkdf2w$${material.iterations}$${material.saltHex}$${material.verifierHex}`;
}

// Parses the public-account password format ("pbkdf2w$..."). Returns null for
// any value that is not a well-formed public hash, including the admin format.
export function parseUserPasswordHash(
  stored: string
): { iterations: number; saltHex: string; verifierHex: string } | null {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2w') return null;
  const iterations = Number(parts[1]);
  if (!Number.isSafeInteger(iterations) || iterations < 10_000) return null;
  if (!/^[0-9a-f]+$/i.test(parts[2])) return null;
  return { iterations, saltHex: parts[2], verifierHex: parts[3] };
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