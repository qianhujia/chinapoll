// Security headers on every admin response.
//
// The dashboard document carries a CSP from its own builder, but the JSON API
// otherwise had no security header at all. A single wrapper in admin/index.ts
// applies the same baseline to both (mirroring the public Worker), so a route
// added later cannot forget the list.

import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import adminWorker, { type Env } from '../../admin/index';
import { applySchema } from './helpers';

const ORIGIN = 'https://admin.example.com';

// The baseline every admin response carries.
const EXPECTED: ReadonlyArray<readonly [string, string]> = [
  ['strict-transport-security', 'max-age=31536000; includeSubDomains'],
  ['x-content-type-options', 'nosniff'],
  ['x-frame-options', 'DENY'],
  ['referrer-policy', 'no-referrer'],
  ['cache-control', 'no-store']
];

beforeAll(async () => {
  await applySchema();
});

function fetchPath(path: string): Promise<Response> {
  return adminWorker.fetch(new Request(`${ORIGIN}${path}`), env as unknown as Env);
}

describe('admin security headers', () => {
  it('applies the baseline to the dashboard document', async () => {
    const response = await fetchPath('/reports/polls');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    for (const [name, value] of EXPECTED) expect(response.headers.get(name), name).toBe(value);
    // The document keeps its own policy as well.
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('applies the baseline to an API response', async () => {
    // The session endpoint answers without a prior session, so no cookie is needed.
    const response = await fetchPath('/api/admin/session');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    for (const [name, value] of EXPECTED) expect(response.headers.get(name), name).toBe(value);
  });

  it('applies the baseline to a rejected API request', async () => {
    // Every other /api/admin/ route needs a session, so this is the 401 path.
    const response = await fetchPath('/api/admin/overview');

    expect(response.status).toBe(401);
    for (const [name, value] of EXPECTED) expect(response.headers.get(name), name).toBe(value);
  });
});