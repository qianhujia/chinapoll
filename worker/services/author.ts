// Per-user author keys and the author mark.
//
// Each public account has a random 32-byte author key that the server never
// stores in clear. The database keeps it only in wrapped (AES-256-GCM) form:
// once under a key derived from the password, once under a key derived from the
// recovery code, and once per session under a key derived from the session
// token. Every poll and comment the account writes stores
// `author_mark = HMAC(authorKey, "author")`, one fixed value per account, which
// is indexed and makes "my polls" and "my comments" ordinary paginated queries.
//
// A leaked database, even together with the server secret, cannot map a poll or
// comment to an account, because the author key is recoverable only from the
// user's password or recovery code. All rows of one account share one author
// mark, so a database reader can still tell that a set of rows came from the
// same anonymous author.
//
// The three wrap keys are:
//   * `recoveryWrapKeyHex` = HMAC-SHA256(UTF-8(normalized code), "recovery-wrap")
//   * `sessionWrapKeyHex`  = HMAC-SHA256(UTF-8(session token), "session-wrap")
//   * the password wrap key, derived from the PBKDF2 output inside the
//     PasswordHasher Durable Object (see shared/password.ts).

import { fromHex, hmacSha256Hex, toHex } from '../../shared/crypto';

// A fresh 32-byte author key as 64 lowercase hex characters.
export function newAuthorKeyHex(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

// The author mark of an author key: HMAC-SHA256(authorKey, "author") as hex.
export function authorMark(authorKeyHex: string): Promise<string> {
  return hmacSha256Hex(fromHex(authorKeyHex), 'author');
}

// The wrap key derived from a normalized recovery code. The HMAC key is the
// UTF-8 bytes of the code string, so it is unrelated to the stored SHA-256 hash.
export function recoveryWrapKeyHex(normalizedCode: string): Promise<string> {
  return hmacSha256Hex(normalizedCode, 'recovery-wrap');
}

// The wrap key derived from a session token. The token is the 64-hex value from
// the cookie, so it is unrelated to the stored SHA-256 `token_hash`.
export function sessionWrapKeyHex(token: string): Promise<string> {
  return hmacSha256Hex(token, 'session-wrap');
}
