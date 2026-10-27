// The admin dashboard's own favicon endpoint.
//
// The dashboard document advertises `/image/favicon.png` on this Worker's own origin,
// so the console shows the favicon the operator configured without depending on the
// public site being reachable. A favicon that was never uploaded answers an empty
// response rather than a 404, because the document always links the path; and a
// pasted URL has no bytes to serve here, since the page loads it directly.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import adminWorker, { type Env } from '../../admin/index';
import { applySchema } from './helpers';

const ORIGIN = 'https://admin.example.com';
const ICON_PATH = '/image/favicon.png';

beforeAll(async () => {
  await applySchema();
});

function fetchPath(path: string): Promise<Response> {
  return adminWorker.fetch(new Request(`${ORIGIN}${path}`), env as unknown as Env);
}

// The branding handler caches a decoded image per isolate for a short window, so a
// test that changes the stored favicon takes a fresh copy of the Worker instead of
// waiting for that window to pass.
async function fetchPathWithFreshWorker(path: string): Promise<Response> {
  vi.resetModules();
  const worker = await import('../../admin/index');
  return worker.default.fetch(new Request(`${ORIGIN}${path}`), env as unknown as Env);
}

async function setFavicon(value: string): Promise<void> {
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('favicon', ?)")
    .bind(value).run();
}

describe('admin favicon endpoint', () => {
  it('answers an empty response while no favicon is configured', async () => {
    await env.DB.prepare("DELETE FROM settings WHERE key = 'favicon'").run();

    const response = await fetchPathWithFreshWorker(ICON_PATH);

    // Not a 404: the dashboard always links this path. The admin Worker's own header
    // wrapper forces `no-store` on everything it returns, images included, so a
    // replaced favicon is never served from a cache.
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('serves an uploaded favicon from the admin origin', async () => {
    await setFavicon('data:image/png;base64,AQIDBA==');

    const response = await fetchPathWithFreshWorker(ICON_PATH);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([1, 2, 3, 4]);
  });

  it('answers the conventional icon path with the same image', async () => {
    const response = await fetchPath('/favicon.ico');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
  });

  it('has nothing to serve for a pasted favicon URL', async () => {
    await setFavicon('https://cdn.example.com/favicon.png');

    expect((await fetchPathWithFreshWorker(ICON_PATH)).status).toBe(204);
  });
});
