// Same-origin enforcement for browser mutations.
//
// A browser sends an Origin header on every POST, same-origin or not, so
// requiring the header to match the request origin refuses a request that a
// third-party page (or a hand-written client) aimed at the Worker. GET, HEAD,
// and OPTIONS are not state changing and are allowed through.
//
// It began as CSRF protection for the cookie-authenticated endpoints, where the
// session cookie is HttpOnly and the Origin check stops a replay from another
// site even in browsers or webviews that do not fully enforce SameSite. The
// anonymous mutations (vote, report, view) apply it too: without it, an
// attacker's page could POST from every visitor's browser and spend each
// visitor's own network budget.

import { apiError } from '../../shared/http';

export function enforceSameOrigin(
  request: Request,
  options: { viaCookie?: boolean; extraOrigin?: string } = {}
): Response | null {
  // Checked by default; a caller opts out only for a request that was not
  // cookie-authenticated and is not driven by a browser, such as the admin API's
  // header authentication.
  if (options.viaCookie === false) return null;
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
    return apiError('CROSS_ORIGIN_REJECTED', 403);
  }
  return null;
}
