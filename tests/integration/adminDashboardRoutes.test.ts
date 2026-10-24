// The admin dashboard is one self-contained HTML document served at every view URL,
// so a sidebar link, a bookmark, and a refresh all reach the same shell that the
// client router resolves from the pathname. Serving happens before authentication
// (the document carries no data), so no session is needed to check that the reports
// routes exist.

import { describe, expect, it } from 'vitest';
import adminWorker, { type Env } from '../../admin/index';

const ORIGIN = 'https://admin.example.com';

function fetchPath(path: string): Promise<Response> {
  return adminWorker.fetch(new Request(`${ORIGIN}${path}`), {} as Env);
}

describe('admin dashboard routes', () => {
  it('serves the dashboard document at every reports URL', async () => {
    for (const path of ['/reports', '/reports/polls', '/reports/comments']) {
      const response = await fetchPath(path);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      const html = await response.text();
      expect(html).toContain('<div id="app"></div>');
      // The queue is resolved from the path in the browser, so the document must
      // carry the router that maps it.
      expect(html).toContain('reportSectionFromPath');
    }
  });

  it('answers 404 for an unknown reports queue', async () => {
    const response = await fetchPath('/reports/unknown');
    expect(response.status).toBe(404);
  });
});