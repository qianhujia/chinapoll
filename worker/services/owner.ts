// Per-poll owner hashes.
//
// A poll stores a one-way HMAC of the server secret, derived for the "owner"
// purpose, with "owner:<userId>:<pollId>" instead of the account id. Self-service
// close and withdraw recompute the HMAC and compare, and "my polls" is answered
// only for poll ids whose HMAC matches. A database leak without the server secret
// therefore reveals no author links.

import { deriveKey, fromHex, hmacSha256Hex } from '../../shared/crypto';
import { isValidServerKey } from './ip';

export async function ownerHash(
  userId: number,
  pollId: number,
  keyHex: string | undefined | null
): Promise<string | null> {
  if (!isValidServerKey(keyHex)) return null;
  const ownerKey = fromHex(await deriveKey(keyHex, 'owner'));
  return hmacSha256Hex(ownerKey, `owner:${userId}:${pollId}`);
}