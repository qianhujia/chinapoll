// Poll link cards: rendering, storage, and the freshness rule.
//
// The poll page advertises /og/poll/<number>.png, so a card builder fetches a PNG instead
// of the page. The Worker draws that PNG itself - the card is an SVG (see ogCard.ts) and
// `@resvg/resvg-wasm` rasterizes it - and keeps the bytes in D1 as a BLOB, so a fetch after
// the first one is a single row read.
//
// Freshness is a signature, not a clock: `ogSignature` reduces the facts the picture was
// drawn from (the poll's number and title) to one string. A stored card whose signature
// still matches is served as it is; one that does not is drawn again. A request that finds
// no card (a poll published since the last hourly run) draws it then, so a link shared right
// after a poll is published is never stale.
//
// The rasterizer is imported as a module, because workerd compiles WebAssembly only at
// deploy time: instantiating bytes fetched at runtime is refused ("Wasm code generation
// disallowed by embedder"), so `index_bg.wasm` travels in the Worker bundle (see
// wrangler.toml). The fonts are data, not code, so they are served from the site's static
// assets (public/og/) and read once per isolate.

import { Resvg, initWasm } from '@resvg/resvg-wasm';
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';
import {
  OG_CARD_HEIGHT,
  OG_CARD_WIDTH,
  buildOgCardSvg,
  type OgCardPoll
} from './ogCard';
import { PollMode, PollStatus } from '../enums';

export const OG_IMAGE_CONTENT_TYPE = 'image/png';
/** How long a card builder (and a shared cache) may reuse a card, in seconds. */
export const OG_IMAGE_MAX_AGE_SECONDS = 600;

const FONT_ASSETS = ['/og/noto-sans-sc-latin.woff2', '/og/noto-sans-sc-chinese-simplified.woff2'];

export interface OgImageEnv {
  DB: D1Database;
  /** The site's static assets, which hold the rasterizer and the fonts. */
  ASSETS?: Fetcher;
}

export interface StoredOgImage {
  signature: string;
  content_type: string;
  /** The PNG bytes. */
  image: Uint8Array;
  width: number;
  height: number;
  generated_at: number;
}

export { OG_CARD_HEIGHT, OG_CARD_WIDTH };

// A BLOB comes back as an `ArrayBuffer` in production and as an array of bytes in the local
// runtime, so a stored card is normalized before it is served or measured. Every branch
// returns a view whose buffer holds exactly the card, so `image.buffer` is the body.
function storedBytes(value: unknown): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  throw new Error('stored card is not a byte sequence');
}

async function assetBytes(assets: Fetcher, path: string): Promise<Uint8Array> {
  const response = await assets.fetch(new Request(`https://assets.local${path}`));
  if (!response.ok) throw new Error(`missing asset ${path}`);
  return new Uint8Array(await response.arrayBuffer());
}

// The rasterizer is initialized once per isolate and the font bytes are read once: the module
// is compiled at deploy time and the assets are immutable for the life of a deployment.
const fontBuffers: Uint8Array[] = [];
let rasterizerReady: Promise<void> | null = null;

function ensureRasterizer(assets: Fetcher): Promise<void> {
  if (!rasterizerReady) {
    rasterizerReady = (async () => {
      await initWasm(resvgWasm);
      for (const path of FONT_ASSETS) fontBuffers.push(await assetBytes(assets, path));
    })().catch((error: unknown) => {
      // A failure is not cached: a later request asks again rather than answering without a
      // card for the life of the isolate.
      rasterizerReady = null;
      fontBuffers.length = 0;
      throw error;
    });
  }
  return rasterizerReady;
}

/** Rasterizes one card. Throws when the assets are unreachable. */
export async function renderOgCard(
  assets: Fetcher,
  svg: string
): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  await ensureRasterizer(assets);
  const resvg = new Resvg(svg, {
    background: '#ffffff',
    font: { fontBuffers, loadSystemFonts: false, defaultFontFamily: 'Noto Sans SC' }
  });
  try {
    const image = resvg.render();
    try {
      return { bytes: image.asPng(), width: image.width, height: image.height };
    } finally {
      image.free();
    }
  } finally {
    resvg.free();
  }
}

// What the picture was drawn from, as one string. Anything that changes the pixels has to
// change this, and anything that does not must leave it alone: the poll's title moves it, a
// vote, a view count, or a timestamp does not.
export function ogSignature(poll: OgCardPoll): string {
  return [poll.number, poll.title].join('\n');
}

function toBytes(bytes: Uint8Array): Uint8Array {
  // A copy, so the stored value is exactly the PNG and not a view over a larger buffer.
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy;
}

/** Draws the card for one poll and stores it. */
export async function drawOgCard(
  env: OgImageEnv,
  poll: OgCardPoll,
  site: { siteName: string }
): Promise<StoredOgImage> {
  if (!env.ASSETS) throw new Error('no assets binding');
  const svg = buildOgCardSvg(poll, { siteName: site.siteName });
  const rendered = await renderOgCard(env.ASSETS, svg);
  const stored: StoredOgImage = {
    signature: ogSignature(poll),
    content_type: OG_IMAGE_CONTENT_TYPE,
    image: toBytes(rendered.bytes),
    width: rendered.width,
    height: rendered.height,
    generated_at: Math.floor(Date.now() / 1000)
  };
  await storeOgImage(env.DB, poll.number, stored);
  return stored;
}

export async function loadOgImage(db: D1Database, pollNumber: number): Promise<StoredOgImage | null> {
  const row = await db.prepare(
    `SELECT o.signature, o.content_type, o.image, o.width, o.height, o.generated_at
     FROM og_images o JOIN polls p ON p.id = o.poll_id WHERE p.number = ?`
  ).bind(pollNumber).first<Omit<StoredOgImage, 'image'> & { image: unknown }>();
  if (!row) return null;
  return { ...row, image: storedBytes(row.image) };
}

export async function storeOgImage(
  db: D1Database,
  pollNumber: number,
  image: StoredOgImage
): Promise<void> {
  await db.prepare(
    `INSERT INTO og_images (poll_id, signature, content_type, image, width, height, generated_at)
     SELECT id, ?, ?, ?, ?, ?, ? FROM polls WHERE number = ?
     ON CONFLICT(poll_id) DO UPDATE SET
       signature = excluded.signature,
       content_type = excluded.content_type,
       image = excluded.image,
       width = excluded.width,
       height = excluded.height,
       generated_at = excluded.generated_at`
  ).bind(
    image.signature, image.content_type, image.image,
    image.width, image.height, image.generated_at, pollNumber
  ).run();
}

// The poll facts a card is drawn from, read the way the page publishes them: the poll list's
// own visibility predicate, so a card exists only for a poll the public can see.
export interface OgCardFacts {
  poll: OgCardPoll;
}

export async function loadOgCardFacts(
  env: OgImageEnv,
  pollNumber: number
): Promise<OgCardFacts | null> {
  const row = await env.DB.prepare(
    `SELECT number, title FROM polls
     WHERE number = ? AND mode IN (?, ?) AND status IN (?, ?, ?)`
  ).bind(
    pollNumber,
    PollMode.Deadline, PollMode.Evergreen,
    PollStatus.Open, PollStatus.Closed, PollStatus.Archived
  ).first<{ number: number; title: string }>();
  if (!row) return null;

  return {
    poll: {
      number: Number(row.number),
      title: String(row.title ?? '')
    }
  };
}

// How many polls one hourly pass looks at. The pass is a safety net for the cards a request
// has already drawn (and a way to keep them current without a visit), so it works on the
// polls that can still change - the open ones, newest first - rather than the whole table.
export const OG_REFRESH_LIMIT = 50;

// Redraws the cards whose poll has changed since they were drawn, and leaves the rest alone.
// A poll that has no card yet is skipped here: a card is first drawn by the request that
// needs it.
export async function refreshOgCards(
  env: OgImageEnv,
  site: { siteName: string },
  limit = OG_REFRESH_LIMIT
): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT p.number
     FROM polls p JOIN og_images o ON o.poll_id = p.id
     WHERE p.status = ? AND p.mode IN (?, ?)
     ORDER BY p.updated_at DESC LIMIT ?`
  ).bind(PollStatus.Open, PollMode.Deadline, PollMode.Evergreen, limit)
    .all<{ number: number }>();

  let redrawn = 0;
  for (const row of rows.results ?? []) {
    const number = Number(row.number);
    const facts = await loadOgCardFacts(env, number);
    if (!facts) continue;
    const stored = await loadOgImage(env.DB, number);
    if (!stored || stored.signature === ogSignature(facts.poll)) continue;

    try {
      const svg = buildOgCardSvg(facts.poll, { siteName: site.siteName });
      const rendered = await renderOgCard(env.ASSETS!, svg);
      await storeOgImage(env.DB, number, {
        signature: ogSignature(facts.poll),
        content_type: OG_IMAGE_CONTENT_TYPE,
        image: rendered.bytes,
        width: rendered.width,
        height: rendered.height,
        generated_at: Math.floor(Date.now() / 1000)
      });
      redrawn += 1;
    } catch (error) {
      // One card that cannot be drawn (an unreachable asset, a font problem) must not stop
      // the run: the stored card stays until the next pass tries again.
      console.error('og card refresh failed', number, error);
    }
  }
  return redrawn;
}


