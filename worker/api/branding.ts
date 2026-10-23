// Serves the configured logo and favicon.
//
// A branding setting holds either an https URL the admin pasted or a base64 data
// URI produced by an upload (see shared/settings.ts). A pasted URL is used by the
// pages directly, so this endpoint only answers for uploaded bytes: it decodes the
// data URI and returns the image. The public settings resolve an uploaded image to
// `/image/<key>.<extension>?v=<updated_at>`, so replacing an image produces a new
// URL and a stale copy is never served. `/favicon.ico` is answered too, for agents
// that request the icon path instead of reading the document's
// `<link rel="icon">`.

export type BrandingKey = 'logo' | 'favicon';

// Headers for a branding response. The Worker's wrapper normally forces
// `no-store` on every response; these bytes are versioned by the URL instead, so
// they carry their own long-lived cache header plus the usual privacy headers and
// a CSP that neutralises a directly opened SVG.
const IMAGE_HEADERS: Record<string, string> = {
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'content-security-policy': "default-src 'none'; sandbox",
  'cache-control': 'public, max-age=31536000, immutable'
};

interface DecodedImage {
  contentType: string;
  bytes: Uint8Array;
  /** The same bytes as the buffer the Response body is built from. */
  body: ArrayBuffer;
}

interface CachedImage {
  image: DecodedImage | null;
  loadedAt: number;
}

// Decoded bytes are cached per isolate for the same short window the settings
// cache uses, so a page refresh does not re-read or re-decode the image.
const IMAGE_TTL_MS = 30_000;
const imageCache = new Map<BrandingKey, CachedImage>();

// An uploaded image is addressed as /image/<key>.<extension>. The extension is
// cosmetic: the stored row decides the content type that is returned, so a wrong
// extension is answered rather than rejected and an image replaced with another
// format keeps working until its versioned URL is regenerated.
const IMAGE_PATH_PATTERN = /^\/image\/(logo|favicon)(?:\.[a-z0-9]+)?$/;

// The branding key a request path names, or null for any other path. Also used by
// the request router to keep these responses out of the `no-store` wrapper.
// `/favicon.ico` is answered as well, for agents that request the conventional
// icon path instead of reading the document's `<link rel="icon">`.
export function brandingKeyFromPath(pathname: string): BrandingKey | null {
  if (pathname === '/favicon.ico') return 'favicon';
  const match = pathname.match(IMAGE_PATH_PATTERN);
  return match ? (match[1] as BrandingKey) : null;
}

// Decodes `data:image/<type>;base64,<payload>`. Returns null for anything else,
// including a pasted URL, which is served by the page rather than by this route.
function decodeImageDataUri(value: string): DecodedImage | null {
  const match = value.match(/^data:(image\/[\w.+-]+);base64,(.*)$/s);
  if (!match) return null;
  try {
    const binary = atob(match[2]);
    const buffer = new ArrayBuffer(binary.length);
    const bytes = new Uint8Array(buffer);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return { contentType: match[1], bytes, body: buffer };
  } catch {
    // A malformed payload is treated as "no image" rather than a 500: the admin
    // validator rejects it, so this only guards against a hand-edited row.
    return null;
  }
}

async function loadBrandingImage(env: { DB: D1Database }, key: BrandingKey): Promise<DecodedImage | null> {
  const now = Date.now();
  const cached = imageCache.get(key);
  if (cached && now - cached.loadedAt < IMAGE_TTL_MS) return cached.image;

  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
    .bind(key)
    .first<{ value: string | null }>();
  const stored = row?.value ?? '';
  const image = stored.startsWith('data:') ? decodeImageDataUri(stored) : null;
  imageCache.set(key, { image, loadedAt: now });
  return image;
}

function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { ...IMAGE_HEADERS, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
  });
}

export async function handleBrandingRequest(
  request: Request,
  url: URL,
  env: { DB: D1Database }
): Promise<Response> {
  const key = brandingKeyFromPath(url.pathname);
  if (!key) return notFound();
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { ...IMAGE_HEADERS, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
    });
  }

  const image = await loadBrandingImage(env, key);
  if (!image) return notFound();

  const headers = {
    ...IMAGE_HEADERS,
    'content-type': image.contentType,
    'content-length': String(image.bytes.byteLength)
  };
  return request.method === 'HEAD'
    ? new Response(null, { headers })
    : new Response(image.body, { headers });
}
