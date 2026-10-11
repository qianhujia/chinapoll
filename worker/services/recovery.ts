// Single-use recovery codes for public user accounts.
//
// Accounts have no email, so one machine-generated recovery code is the only way
// to regain access after a forgotten password. The plaintext code is returned to
// the caller exactly once; the database stores only its SHA-256 hash. The code
// carries about 120 bits of entropy, so a fast hash is enough: an attacker who
// steals the hash still cannot brute-force the code.

import { sha256Hex } from '../../shared/crypto';

// Crockford base32 alphabet: I, L, O, and U are omitted so a code is hard to
// misread or mistype when a user copies it by hand.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
// 24 base32 characters carry about 120 bits of entropy.
const CODE_LENGTH = 24;
const GROUP_SIZE = 4;

export interface GeneratedRecoveryCode {
  /** Plaintext code, shown to the user exactly once and never persisted. */
  code: string;
  /** SHA-256 hash stored in the database. */
  hash: string;
}

function randomCode(): string {
  // 256 is a multiple of the 32-character alphabet, so the modulo is unbiased.
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let code = '';
  for (const byte of bytes) code += ALPHABET[byte % ALPHABET.length];
  return code;
}

// Groups the raw code for readability: "ABCD-EFGH-IJKM-NPQR-STVW".
export function formatRecoveryCode(code: string): string {
  const groups: string[] = [];
  for (let index = 0; index < code.length; index += GROUP_SIZE) {
    groups.push(code.slice(index, index + GROUP_SIZE));
  }
  return groups.join('-');
}

// Normalizes user input before hashing: uppercase, drop separators, and fold the
// characters that Crockford base32 treats as equivalent (I/L -> 1, O -> 0).
export function normalizeRecoveryCode(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
}

export async function hashRecoveryCode(code: string): Promise<string> {
  return sha256Hex(normalizeRecoveryCode(code));
}

export async function generateRecoveryCode(): Promise<GeneratedRecoveryCode> {
  const code = formatRecoveryCode(randomCode());
  return { code, hash: await hashRecoveryCode(code) };
}