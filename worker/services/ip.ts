// Anonymized network bucket and keyed, daily-rotated hashing.
//
// `ipBucket()` reduces an address to a small, stable bucket that is used for the
// per-network account cap. A dotted IPv4 address becomes its /24 network as a
// 32-bit unsigned integer (203.0.113.10 -> 203.0.113.0 = 3405803776); any other
// value (IPv6 or unparseable) is folded with FNV-1a so a full address is never
// kept while different sources still map to different buckets.
//
// `hashedNetworkBucket()` turns that bucket into a keyed HMAC that is rotated
// once per day. There are only about 16 million /24 prefixes, so an unkeyed hash
// is reversible with a lookup table; a secret key removes that risk, and the
// daily rotation means the stored value cannot be correlated across days.

import { deriveKey, fromHex, hmacSha256, hmacSha256Hex } from '../../shared/crypto';

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\.\d{1,3})?$/;
const SERVER_KEY_PATTERN = /^[0-9a-f]{64}$/i;

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function ipBucket(address: string): number {
  const match = IPV4_PATTERN.exec((address ?? '').trim());
  if (match) {
    const a = Number(match[1]);
    const b = Number(match[2]);
    const c = Number(match[3]);
    if (a <= 255 && b <= 255 && c <= 255) {
      return (((a << 24) | (b << 16) | (c << 8)) >>> 0);
    }
  }
  return fnv1a(address ?? '');
}

export function isValidServerKey(keyHex: string | undefined | null): keyHex is string {
  return typeof keyHex === 'string' && SERVER_KEY_PATTERN.test(keyHex);
}

// Returns the server HMAC master key. The current name is SERVER_HMAC_KEY;
// IP_HASH_KEY is accepted as a fallback for one release so an existing deployment
// keeps working until the secret is renamed.
export function serverHmacKey(
  env: { SERVER_HMAC_KEY?: string; IP_HASH_KEY?: string }
): string | undefined {
  return env.SERVER_HMAC_KEY ?? env.IP_HASH_KEY;
}

// The rotation period for the keyed hash. `month` keeps a value linkable within
// a calendar month (used for the 30-day account cap); `day` is the default and
// is used everywhere rate limiting applies.
export type IpHashPeriod = 'day' | 'month';

// Returns the keyed hash of the network bucket for an address, or null when the
// configured key is missing or malformed. The sub-key rotates per `period`: a
// YYYY-MM-DD stamp for 'day' and a YYYY-MM stamp for 'month'.
export async function hashedNetworkBucket(
  address: string,
  keyHex: string | undefined | null,
  date: Date = new Date(),
  period: IpHashPeriod = 'day'
): Promise<string | null> {
  if (!isValidServerKey(keyHex)) return null;
  const iso = date.toISOString();
  const stamp = period === 'month' ? iso.slice(0, 7) : iso.slice(0, 10);
  const networkKey = fromHex(await deriveKey(keyHex, 'network'));
  const periodKey = await hmacSha256(networkKey, stamp);
  return hmacSha256Hex(periodKey, String(ipBucket(address)));
}

// Reads the client address from the request headers. Callers still hash the
// value; this never stores or logs the raw address.
export function clientAddress(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? '127.0.0.1';
}
