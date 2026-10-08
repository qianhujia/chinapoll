export async function sha256(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function computeHashChain(previousHash: string | null, payload: string): Promise<string> {
  return sha256(`${previousHash ?? 'GENESIS'}:${payload}`);
}

export function hashString(value: string): string {
  return value
    .split('')
    .reduce((hash, char) => {
      return (hash * 31 + char.charCodeAt(0)) >>> 0;
    }, 0)
    .toString(16);
}
