// Shared cryptographic helpers used by both the public and the admin Worker.
//
// Keeping one copy of these primitives avoids the two Workers drifting apart.
// The module has no runtime dependencies and runs on the Web Crypto API that is
// available in Workers, which is all that is needed here.

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return new Uint8Array(0);
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return toHex(new Uint8Array(digest));
}

// Imports a raw byte string as an HMAC key. The key length is not checked here;
// callers that need a specific size validate the hex string before calling.
async function importHmacKey(key: Uint8Array | string): Promise<CryptoKey> {
  const bytes = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  return crypto.subtle.importKey(
    'raw',
    bytes as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

// Returns the raw HMAC-SHA256 digest bytes for a message.
export async function hmacSha256(key: Uint8Array | string, message: string): Promise<Uint8Array<ArrayBuffer>> {
  const cryptoKey = await importHmacKey(key);
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message) as BufferSource);
  return new Uint8Array(signature);
}

// Returns the HMAC-SHA256 digest of a message as lowercase hex.
export async function hmacSha256Hex(key: Uint8Array | string, message: string): Promise<string> {
  return toHex(await hmacSha256(key, message));
}

// Derives a purpose-specific sub-key from a master key: HMAC(master, purpose).
// Distinct purposes keep one derived value from helping with another, so a
// verifier can never be turned into a wrap key. `masterHex` must be a
// 64-character hex string; the result is also 64 hex characters.
export async function deriveKey(masterHex: string, purpose: string): Promise<string> {
  return hmacSha256Hex(fromHex(masterHex), purpose);
}

// Wraps a small hex secret (for example an author key) under a 64-hex wrap key
// using AES-256-GCM. The random 12-byte IV is prefixed to the ciphertext as
// "<ivHex>:<ciphertextHex>"; the ciphertext includes the 16-byte GCM tag.
export async function wrapHex(wrapKeyHex: string, plaintextHex: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    fromHex(wrapKeyHex) as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    fromHex(plaintextHex) as BufferSource
  );
  return `${toHex(iv)}:${toHex(new Uint8Array(ciphertext))}`;
}

// Unwraps a value produced by `wrapHex`. Returns the plaintext as hex, or null
// on any failure (bad format, wrong key, or tampered data). It never throws.
export async function unwrapHex(wrapKeyHex: string, stored: string): Promise<string | null> {
  try {
    const parts = stored.split(':');
    if (parts.length !== 2) return null;
    const [ivHex, ciphertextHex] = parts;
    if (fromHex(ivHex).length === 0 || fromHex(ciphertextHex).length === 0) return null;
    const key = await crypto.subtle.importKey(
      'raw',
      fromHex(wrapKeyHex) as BufferSource,
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromHex(ivHex) as BufferSource },
      key,
      fromHex(ciphertextHex) as BufferSource
    );
    return toHex(new Uint8Array(plaintext));
  } catch {
    return null;
  }
}

// Compares two strings without leaking their content through timing differences.
export function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}