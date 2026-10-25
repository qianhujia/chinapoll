// Anonymized network bucket and keyed, daily-rotated hashing.
//
// `ipBucket()` reduces an address to a small, stable bucket that is used for the
// per-network account cap and the vote, register, report, and view limits. A
// dotted IPv4 address becomes its /24 network as a 32-bit unsigned integer
// (203.0.113.10 -> 203.0.113.0 = 3405803776). An IPv6 address is parsed and folded
// to its /64 prefix, so one subscriber allocation is one bucket instead of one
// bucket per address. Anything that is neither (empty, a hostname, a malformed
// address) falls back to FNV-1a over the text, so a full address is never kept
// while different sources still map to different buckets.
//
// `hashedNetworkBucket()` turns that bucket into a keyed HMAC that is rotated
// once per day. There are only about 16 million /24 prefixes, so an unkeyed hash
// is reversible with a lookup table; a secret key removes that risk, and the
// daily rotation means the stored value cannot be correlated across days.

import { deriveKey, fromHex, hmacSha256, hmacSha256Hex } from '../../shared/crypto';

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\.\d{1,3})?$/;
const IPV6_GROUP_PATTERN = /^[0-9a-f]{1,4}$/i;
const IPV6_GROUPS = 8;
// The leading groups that make up the /64 prefix an IPv6 address is folded to.
const IPV6_PREFIX_GROUPS = 4;
const SERVER_KEY_PATTERN = /^[0-9a-f]{64}$/i;

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// The two 16-bit groups of a dotted quad, or null when the text is not one. Used
// for the IPv4-embedded form of an IPv6 address, such as `::ffff:203.0.113.10`.
function dottedQuadGroups(text: string): [number, number] | null {
  const octets = text.split('.');
  if (octets.length !== 4) return null;
  if (octets.some((octet) => !/^\d{1,3}$/.test(octet))) return null;
  const values = octets.map(Number);
  if (values.some((value) => value > 255)) return null;
  return [((values[0] << 8) | values[1]) >>> 0, ((values[2] << 8) | values[3]) >>> 0];
}

// The groups written on one side of a `::` split. An empty side contributes
// nothing, and the final group may be a dotted quad, which stands for two groups.
function ipv6Side(text: string): number[] | null {
  if (text === '') return [];
  const parts = text.split(':');
  const groups: number[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (IPV6_GROUP_PATTERN.test(part)) {
      groups.push(Number.parseInt(part, 16));
      continue;
    }
    if (index !== parts.length - 1) return null;
    const pair = dottedQuadGroups(part);
    if (!pair) return null;
    groups.push(pair[0], pair[1]);
  }
  return groups;
}

// Parses an IPv6 address into its eight 16-bit groups, accepting the compressed
// ("::") and IPv4-embedded forms a proxy may report. Returns null for anything
// else, including an IPv4 address.
function parseIpv6(value: string): number[] | null {
  if (value.indexOf(':') === -1) return null;
  const halves = value.split('::');
  if (halves.length > 2) return null;

  const head = ipv6Side(halves[0]);
  const tail = ipv6Side(halves.length === 2 ? halves[1] : '');
  if (!head || !tail) return null;
  const written = head.length + tail.length;

  if (halves.length === 2) {
    // The compression stands for at least one zero group.
    if (written >= IPV6_GROUPS) return null;
    return [...head, ...new Array<number>(IPV6_GROUPS - written).fill(0), ...tail];
  }
  return written === IPV6_GROUPS ? [...head, ...tail] : null;
}

// Folds a parsed address to its /64 prefix: the leading groups are combined into
// two 32-bit halves and XORed, which keeps every bit of the prefix in a value a
// JavaScript number holds exactly. One subscriber network therefore shares one
// bucket, so a single /64 allocation cannot mint unlimited per-address buckets for
// the vote, register, report, and view limits.
function ipv6PrefixBucket(groups: number[]): number {
  const prefix = groups.slice(0, IPV6_PREFIX_GROUPS);
  const high = ((prefix[0] << 16) | prefix[1]) >>> 0;
  const low = ((prefix[2] << 16) | prefix[3]) >>> 0;
  return (high ^ low) >>> 0;
}

export function ipBucket(address: string): number {
  const value = (address ?? '').trim();
  const match = IPV4_PATTERN.exec(value);
  if (match) {
    const a = Number(match[1]);
    const b = Number(match[2]);
    const c = Number(match[3]);
    if (a <= 255 && b <= 255 && c <= 255) {
      return (((a << 24) | (b << 16) | (c << 8)) >>> 0);
    }
  }

  const groups = parseIpv6(value);
  if (groups) return ipv6PrefixBucket(groups);

  return fnv1a(value);
}

export function isValidServerKey(keyHex: string | undefined | null): keyHex is string {
  return typeof keyHex === 'string' && SERVER_KEY_PATTERN.test(keyHex);
}

// Returns the server HMAC master key. The name is SERVER_HMAC_KEY; the earlier
// IP_HASH_KEY alias is no longer read, so a deployment that still sets only that name
// has no usable key and the health endpoint reports `serverKey: false`.
export function serverHmacKey(env: { SERVER_HMAC_KEY?: string }): string | undefined {
  return env.SERVER_HMAC_KEY;
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
