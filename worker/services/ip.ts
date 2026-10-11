// Anonymized network bucket used for rate limiting and the per-network account
// cap.
//
// The bucket is a 32-bit unsigned integer. A dotted IPv4 address is reduced to
// its /24 network (for example 203.0.113.10 -> 203.0.113.0 = 3405803776). Any
// other value (IPv6 or an unparseable address) is folded with FNV-1a so a full
// address is never stored while different sources still map to different
// buckets. SQLite has no unsigned type, so the value is stored in an INTEGER
// column and is always kept in the 0..4294967295 range.

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\.\d{1,3})?$/;

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
