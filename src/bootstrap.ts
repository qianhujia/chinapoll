// Reader for the server-rendered bootstrap island.
//
// The Worker embeds the settings, the translation dictionary, the topic list and
// the poll list (on a poll-list route), and (on a poll page) that page's poll data
// in a `<script type="application/json" id="bootstrap">` element, so the client
// does not have to fetch them right after the document arrives (see
// worker/services/bootstrap.ts). Everything read here is validated by the caller
// exactly like an API response, and a missing or malformed island simply means
// "fetch it instead": the island is an optimization, never the only source of the
// data.

import type { PollTopic } from './lib/poll';

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
  /** The `GET /api/topics` body, on the first document of a poll-list route. */
  topics?: unknown;
  /** The `GET /api/polls` body for the poll-list view, on the same route. */
  polls?: unknown;
}

// The island's topics section: the same body `GET /api/topics` answers with. The
// home page renders its chip row from it instead of calling the endpoint.
export interface BootstrapTopicsPayload {
  topics: PollTopic[];
  total: number;
}

// The island's poll-list section: the same body `GET /api/polls` answers with for
// one view. The home page renders its list from it instead of calling the endpoint.
export interface BootstrapPollsPayload {
  page: number;
  query: string;
  topic: string;
  /** The `GET /api/polls` body. */
  body: unknown;
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

// The island's topics section, or null when the document has none (a client-side
// route change serves no new document) or the value is not the expected shape. The
// caller renders the topic chip row from it instead of calling GET /api/topics.
export function bootstrapTopics(): BootstrapTopicsPayload | null {
  const topics = readBootstrap()?.topics;
  if (typeof topics !== 'object' || topics === null) return null;
  const candidate = topics as { topics?: unknown; total?: unknown };
  if (!Array.isArray(candidate.topics) || typeof candidate.total !== 'number') return null;
  return { topics: candidate.topics as PollTopic[], total: candidate.total };
}

// The island's poll-list section, but only when it describes exactly the view
// being rendered: the same page, search query, and topic filter. Any other view (a
// client-side navigation, or a different page/query/topic) returns null so the
// caller fetches GET /api/polls rather than rendering a list for the wrong view.
export function bootstrapPolls(page: number, query: string, topic: string): BootstrapPollsPayload | null {
  const polls = readBootstrap()?.polls;
  if (typeof polls !== 'object' || polls === null) return null;
  const candidate = polls as { page?: unknown; query?: unknown; topic?: unknown; body?: unknown };
  if (candidate.page !== page || candidate.query !== query || candidate.topic !== topic) return null;
  if (typeof candidate.body !== 'object' || candidate.body === null) return null;
  return { page, query, topic, body: candidate.body };
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
