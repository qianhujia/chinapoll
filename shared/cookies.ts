// Shared cookie helpers used by both Workers.

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    if (key === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return null;
}

export function buildCookie(
  name: string,
  value: string,
  options: { secure: boolean; maxAge: number; sameSite?: 'Lax' | 'Strict' }
): string {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${options.sameSite ?? 'Strict'}`,
    `Max-Age=${options.maxAge}`
  ];
  if (options.secure) attributes.push('Secure');
  return attributes.join('; ');
}