// Poll link cards: the route a card builder fetches, and the freshness rule behind it.
//
// The card is drawn in the Worker (svg -> png through @resvg/resvg-wasm, with the fonts that
// ship in public/og) and kept in D1, so a card builder that fetches it twice pays for one
// render. This file covers what a fetch sees: a real PNG at the size a card builder wants,
// the cache headers, the validator, and the rule that a card is redrawn only when the poll
// it describes has changed.

import { beforeAll, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { ORIGIN, applySchema, insertBallot, lastId, seedOptions, seedPoll } from './helpers';

beforeAll(async () => {
  await applySchema();
  // Every poll here is above the display threshold, so its counts are published - which is
  // what makes the redraw rule observable.
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('min_votes_to_display', '0')").run();
});

// A published poll: the number the card is addressed by, with its options seeded.
async function seedPublishedPoll(title: string): Promise<{ id: number; number: number }> {
  const id = await seedPoll({ title });
  const number = id + 500;
  await env.DB.prepare('UPDATE polls SET number = ? WHERE id = ?').bind(number, id).run();
  return { id, number };
}

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

// The signature of the stored card for a poll, which is what decides a redraw.
async function cardSignature(pollId: number): Promise<string | undefined> {
  const row = await env.DB.prepare('SELECT signature FROM og_images WHERE poll_id = ?')
    .bind(pollId).first<{ signature: string }>();
  return row?.signature;
}

describe('poll link cards', () => {
  it('draws a PNG card with the poll on it, and stores it', async () => {
    const poll = await seedPublishedPoll('拆墙：完全取消对境外网站的访问限制');
    await seedOptions(poll.id, [
      { position: 1, label: '赞同' },
      { position: 2, label: '中立' },
      { position: 3, label: '反对' }
    ]);

    const response = await SELF.fetch(`${ORIGIN}/og/poll/${poll.number}.png`);
    const bytes = new Uint8Array(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    // A card builder may reuse it for ten minutes.
    expect(response.headers.get('cache-control')).toBe('public, max-age=600');
    expect(response.headers.get('etag')).toMatch(/^"[0-9a-f]{64}"$/);
    // A real PNG: the signature, then the size in the IHDR chunk.
    expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(pngSize(bytes)).toEqual({ width: 1200, height: 630 });
    // Text was drawn: a card with no glyphs is a flat rectangle of a couple of kilobytes.
    expect(bytes.length).toBeGreaterThan(5000);

    const row = await env.DB.prepare(
      `SELECT signature, content_type, site_url, length(image) AS bytes
       FROM og_images WHERE poll_id = ?`
    ).bind(poll.id).first<{ signature: string; content_type: string; site_url: string; bytes: number }>();
    expect(row?.content_type).toBe('image/png');
    // The PNG is stored as a BLOB rather than as hex text.
    expect(row?.bytes).toBe(bytes.length);
    expect(row?.signature).toContain('拆墙：完全取消对境外网站的访问限制');
    // The address the card prints is kept with it, so the hourly run can redraw it later.
    expect(row?.site_url).toBe(`${ORIGIN.replace(/^https?:\/\//, '')}/poll/${poll.number}`);
  });

  it('renders the title itself rather than one shared placeholder box', async () => {
    const chinese = await seedPublishedPoll('同意拆除所有的围墙');
    const latin = await seedPublishedPoll('Bike lanes on Main Street');
    await seedOptions(chinese.id, [{ position: 1, label: 'Yes' }, { position: 2, label: 'No' }]);
    await seedOptions(latin.id, [{ position: 1, label: 'Yes' }, { position: 2, label: 'No' }]);

    const first = new Uint8Array(await (await SELF.fetch(`${ORIGIN}/og/poll/${chinese.number}.png`)).arrayBuffer());
    const second = new Uint8Array(await (await SELF.fetch(`${ORIGIN}/og/poll/${latin.number}.png`)).arrayBuffer());

    // Different titles produce different pictures. A font that could not draw them would
    // produce the same one (one .notdef box, or nothing at all).
    expect(first.length).not.toBe(second.length);
  });

  it('serves the stored card again, and answers 304 to its validator', async () => {
    const poll = await seedPublishedPoll('A card that is fetched twice');
    await seedOptions(poll.id, [{ position: 1, label: 'Yes' }, { position: 2, label: 'No' }]);

    const first = await SELF.fetch(`${ORIGIN}/og/poll/${poll.number}.png`);
    const firstBytes = new Uint8Array(await first.arrayBuffer());
    const etag = first.headers.get('etag')!;
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);

    const again = await SELF.fetch(`${ORIGIN}/og/poll/${poll.number}.png`);
    expect(again.status).toBe(200);
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(firstBytes);

    const notModified = await SELF.fetch(`${ORIGIN}/og/poll/${poll.number}.png`, {
      headers: { 'if-none-match': etag }
    });
    expect(notModified.status).toBe(304);
  });

  it('redraws the card once a vote changes the standing', async () => {
    const poll = await seedPublishedPoll('A card that follows the votes');
    const options = await seedOptions(poll.id, [
      { position: 1, label: 'Yes' },
      { position: 2, label: 'No' }
    ]);

    const before = new Uint8Array(await (await SELF.fetch(`${ORIGIN}/og/poll/${poll.number}.png`)).arrayBuffer());
    const beforeSignature = await cardSignature(poll.id);

    await insertBallot(poll.id, 'c'.repeat(64), [options.get(1)!]);

    const after = new Uint8Array(await (await SELF.fetch(`${ORIGIN}/og/poll/${poll.number}.png`)).arrayBuffer());

    // The tally moved, so the signature and the picture did too.
    expect(await cardSignature(poll.id)).not.toBe(beforeSignature);
    expect(after.length).not.toBe(before.length);
  });

  it('answers 404 for a poll the public cannot see, and for one that does not exist', async () => {
    const pending = await seedPoll({ title: 'A card for a poll under review', status: 4 });
    await env.DB.prepare('UPDATE polls SET number = ? WHERE id = ?').bind(pending + 500, pending).run();

    expect((await SELF.fetch(`${ORIGIN}/og/poll/${pending + 500}.png`)).status).toBe(404);
    expect((await SELF.fetch(`${ORIGIN}/og/poll/${(await lastId()) + 900}.png`)).status).toBe(404);
  });
});
