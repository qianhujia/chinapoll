// Per-poll and per-comment owner hashes.
//
// A row stores a one-way HMAC of the server secret, derived for the "owner"
// purpose, over a message that names the subject. Self-service close and withdraw
// recompute the HMAC and compare, and "my polls" is answered only for poll ids
// whose HMAC matches. A database leak without the server secret therefore reveals
// no author links.
//
// The poll message is `owner:<userId>:<pollId>` and must never change: every stored
// `polls.owner_hash` was derived that way, so a different message would make the
// existing rows unrecognisable to their own author. A comment namespaces its subject
// (`owner:<userId>:comment:<publicId>`) so it can never collide with a poll id.

import { deriveKey, fromHex, hmacSha256Hex } from '../../shared/crypto';
import { isValidServerKey } from './ip';

export async function ownerHash(
  userId: number,
  pollId: number,
  keyHex: string | undefined | null
): Promise<string | null> {
  return subjectHash(userId, `${pollId}`, keyHex);
}

// The owner hash of a comment. Its random public id is generated before the insert,
// so the hash is derived from that instead of an auto-increment id.
export async function commentOwnerHash(
  userId: number,
  publicId: string,
  keyHex: string | undefined | null
): Promise<string | null> {
  return subjectHash(userId, `comment:${publicId}`, keyHex);
}

async function subjectHash(
  userId: number,
  subject: string,
  keyHex: string | undefined | null
): Promise<string | null> {
  if (!isValidServerKey(keyHex)) return null;
  const ownerKey = fromHex(await deriveKey(keyHex, 'owner'));
  return hmacSha256Hex(ownerKey, `owner:${userId}:${subject}`);
}
