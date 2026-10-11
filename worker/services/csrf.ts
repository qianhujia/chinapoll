// Same-origin enforcement for cookie-authenticated mutations.
//
// The session cookie is HttpOnly; this adds an Origin check so a cookie cannot
// be replayed from another site even in browsers or webviews that do not fully
// enforce SameSite. GET, HEAD, and OPTIONS are not state changing and are
// allowed through.

export function enforceSameOrigin(
  request: Request,
  options: { viaCookie: boolean; extraOrigin?: string } = { viaCookie: true }
): Response | null {
  if (!options.viaCookie) return null;
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;

  const origin = request.headers.get('origin');
  const requestOrigin = new URL(request.url).origin;
  const allowed = new Set([requestOrigin]);
  if (options.extraOrigin) {
    try {
      allowed.add(new URL(options.extraOrigin).origin);
    } catch {
      // Ignore a malformed extra origin value.
    }
  }

  if (!origin || !allowed.has(origin)) {
    return Response.json({ message: 'cross-origin request rejected' }, { status: 403 });
  }
  return null;
}