// Per-poll owner hashes.
//
// A poll stores a one-way HMAC of the server secret with "owner:<userId>:<pollId>"
// instead of the account id. Self-service close and withdraw recompute the HMAC
// and compare, and "my polls" is answered only for poll ids whose HMAC matches.
// A database leak without `IP_HASH_KEY` therefore reveals no author links.

import { fromHex, hmacSha256Hex } from '../../shared/crypto';
import { isValidIpHashKey } from './ip';

export async function ownerHash(
  userId: number,
  pollId: number,
  keyHex: string | undefined | null
): Promise<string | null> {
  if (!isValidIpHashKey(keyHex)) return null;
  return hmacSha256Hex(fromHex(keyHex), `owner:${userId}:${pollId}`);
}