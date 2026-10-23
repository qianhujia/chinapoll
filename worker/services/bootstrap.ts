// The bootstrap island: the data the SPA would otherwise fetch right after the
// document, serialized into that same document.
//
// The client boots from the served document, so `/api/settings/public`,
// `/i18n/<locale>.json`, and (on a poll page) the poll detail, its results, and
// its first comment page are embedded in a `<script type="application/json"
// id="bootstrap">` element. The client reads them from there and only falls back
// to the fetch when the island is absent or does not describe the current view
// (a client-side route change serves no new document).
//
// The island carries nothing the client could not fetch itself: private settings
// are stripped by `publicSettingsPayload` (see ../api/settings), and the
// anonymous vote status is deliberately absent because it is derived from the
// browser's own vote token, which the server never sees while rendering.
//
// The element is inert markup - `type="application/json"` is never executed - so
// the document keeps its strict `script-src 'self'` policy without needing
// `'unsafe-inline'`. Every value is escaped by `serializeJsonScript`, so a poll
// title or translation containing markup cannot close the element.

import { handleCommentsRequest } from '../api/comments';
import { handlePollsRequest } from '../api/polls';
import { publicSettingsPayload, type PublicSettings } from '../api/settings';
import { handleStatsRequest } from '../api/stats';
import type { HandlerEnv } from '../index';
import { serializeJsonScript } from './html';
import { dictionaryFor } from './ssr';

/** The id of the island element, shared with the client reader. */
export const BOOTSTRAP_ELEMENT_ID = 'bootstrap';

export interface BootstrapPollPayload {
  id: number;
  /** The comment page and size the payload describes, so the client can tell
   * whether it matches the view it is about to render. */
  commentsPage: number;
  commentsPageSize: number;
  /** The `GET /api/polls/<id>` body, or undefined when that lookup failed. */
  detail?: unknown;
  /** The `GET /api/stats/<id>` body, or undefined when that lookup failed. */
  stats?: unknown;
  /** The `GET /api/comments/<id>` body, or undefined when that lookup failed. */
  comments?: unknown;
}

export interface BootstrapPayload {
  /** The `GET /api/settings/public` body. */
  settings: Record<string, unknown>;
  /** The locale `i18n` holds the dictionary for. */
  locale: string;
  /** The `/i18n/<locale>.json` dictionary. */
  i18n: Record<string, string>;
  /** Poll page payload; absent on every other route. */
  poll?: BootstrapPollPayload;
}

export function renderBootstrapScript(payload: BootstrapPayload): string {
  return `<script type="application/json" id="${BOOTSTRAP_ELEMENT_ID}">${serializeJsonScript(payload)}</script>`;
}

// Inserts the island at the end of the body, before the closing tag, so it is
// parsed before the deferred module script runs. A shell without a body is
// returned unchanged.
export function injectBootstrapScript(html: string, script: string): string {
  const index = html.lastIndexOf('</body>');
  if (index === -1) return html;
  return `${html.slice(0, index)}${script}\n  ${html.slice(index)}`;
}

// Calls one JSON API handler in-process and returns its body, or undefined when
// the handler rejects the request or the lookup fails. Reusing the handlers keeps
// the island byte-for-byte the API shape instead of a second query that could
// drift from it.
async function callJson(
  handler: (request: Request, url: URL, env: HandlerEnv) => Promise<Response>,
  env: HandlerEnv,
  target: string
): Promise<unknown> {
  try {
    const url = new URL(target);
    const response = await handler(new Request(url, { method: 'GET' }), url, env);
    return response.ok ? await response.json() : undefined;
  } catch {
    return undefined;
  }
}

// The island's poll section for one poll page: the detail, the results, and the
// comment page the request asked for. Returns undefined when the poll is not
// server-rendered at all (the caller only embeds this for a 200 poll page).
export async function buildPollBootstrap(
  env: HandlerEnv,
  origin: string,
  pollId: number,
  commentsPage: number,
  commentsPageSize: number
): Promise<BootstrapPollPayload | undefined> {
  const [detail, stats, comments] = await Promise.all([
    callJson(handlePollsRequest, env, `${origin}/api/polls/${pollId}`),
    callJson(handleStatsRequest, env, `${origin}/api/stats/${pollId}`),
    callJson(
      handleCommentsRequest,
      env,
      `${origin}/api/comments/${pollId}?page=${commentsPage}&pageSize=${commentsPageSize}`
    )
  ]);

  if (detail === undefined && stats === undefined && comments === undefined) return undefined;
  return { id: pollId, commentsPage, commentsPageSize, detail, stats, comments };
}

// Builds the whole island payload for one document. `settings` is the loaded
// public settings (never the merged environment, whose bindings and server secret
// must not reach the document); `env` is used for the Turnstile fields and for the
// in-process API lookups of the poll payload.
export async function buildBootstrapPayload(
  env: HandlerEnv,
  settings: PublicSettings,
  origin: string,
  poll?: { id: number; commentsPage: number; commentsPageSize: number }
): Promise<BootstrapPayload> {
  const payload: BootstrapPayload = {
    settings: publicSettingsPayload(settings, env),
    locale: settings.default_locale,
    i18n: dictionaryFor(settings.default_locale)
  };

  if (poll) {
    const pollPayload = await buildPollBootstrap(
      env,
      origin,
      poll.id,
      poll.commentsPage,
      poll.commentsPageSize
    );
    if (pollPayload) payload.poll = pollPayload;
  }

  return payload;
}
