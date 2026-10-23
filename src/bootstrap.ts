// Reader for the server-rendered bootstrap island.
//
// The Worker embeds the settings, the translation dictionary, and (on a poll
// page) that page's poll data in a `<script type="application/json"
// id="bootstrap">` element, so the client does not have to fetch them right after
// the document arrives (see worker/services/bootstrap.ts). Everything read here is
// validated by the caller exactly like an API response, and a missing or
// malformed island simply means "fetch it instead": the island is an
// optimization, never the only source of the data.

export const BOOTSTRAP_ELEMENT_ID = 'bootstrap';

export interface BootstrapPollPayload {
  id: number;
  /** The comment page and size the payload describes. */
  commentsPage: number;
  commentsPageSize: number;
  /** The `GET /api/polls/<id>` body; absent when that lookup failed. */
  detail?: unknown;
  /** The `GET /api/stats/<id>` body; absent when that lookup failed. */
  stats?: unknown;
  /** The `GET /api/comments/<id>` body; absent when that lookup failed. */
  comments?: unknown;
}

export interface BootstrapPayload {
  settings?: Record<string, unknown>;
  locale?: string;
  i18n?: Record<string, string>;
  poll?: BootstrapPollPayload;
}

// The parsed island, or null when there is none (a client-side route change
// serves no new document) or it cannot be parsed.
export function readBootstrap(): BootstrapPayload | null {
  if (typeof document === 'undefined') return null;
  const element = document.getElementById(BOOTSTRAP_ELEMENT_ID);
  if (!element) return null;
  try {
    const parsed: unknown = JSON.parse(element.textContent ?? '');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as BootstrapPayload;
  } catch {
    return null;
  }
}

// The island's poll section, but only when it describes exactly the view being
// rendered: the same poll and the same comment page and size. A client-side
// navigation to another poll, or a different comment page, returns null so the
// caller fetches the data instead.
export function bootstrapPoll(
  pollId: number,
  commentsPage: number,
  commentsPageSize: number
): BootstrapPollPayload | null {
  const poll = readBootstrap()?.poll;
  if (!poll
    || poll.id !== pollId
    || poll.commentsPage !== commentsPage
    || poll.commentsPageSize !== commentsPageSize) {
    return null;
  }
  return poll;
}
