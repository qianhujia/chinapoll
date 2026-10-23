// Cache headers on the document, the API, and the static assets.
//
// A document and an API response must never be stored: the document carries the
// viewer's settings and the bootstrap island, and the API answers per viewer. The
// fingerprinted SPA bundle is cacheable instead - before this rule, every
// navigation re-downloaded the whole bundle (see `isPrivateResponse` in
// worker/index.ts and the rules in `public/_headers`).

import { beforeAll, describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import { ORIGIN, applySchema } from './helpers';

beforeAll(async () => {
  await applySchema();
});

describe('cache headers', () => {
  it('never stores the HTML document', async () => {
    const response = await SELF.fetch(`${ORIGIN}/`);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('never stores an API response', async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/settings/public`);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('never stores an error response', async () => {
    const response = await SELF.fetch(`${ORIGIN}/assets/does-not-exist.js`);
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('lets the fingerprinted SPA bundle be cached', async () => {
    // The asset name is read from the served shell, so the test survives a new
    // build hash.
    const assetPath = /src="(\/assets\/[^"]+)"/.exec(await (await SELF.fetch(`${ORIGIN}/`)).text())?.[1];
    expect(assetPath).toBeTruthy();

    const response = await SELF.fetch(`${ORIGIN}${assetPath}`);
    const cacheControl = response.headers.get('cache-control') ?? '';
    expect(response.status).toBe(200);
    expect(cacheControl).toContain('max-age=31556952');
    expect(cacheControl).toContain('immutable');
  });

  it('leaves the i18n dictionaries to the asset layer default', async () => {
    // A Worker-rendered document carries the default locale's dictionary in the
    // bootstrap island, so this file is only fetched as a fallback. It keeps the
    // asset layer default (revalidate) rather than a fixed max-age, so a deploy's
    // new strings cannot stay invisible behind a cache.
    const response = await SELF.fetch(`${ORIGIN}/i18n/en.json`);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
  });
});
