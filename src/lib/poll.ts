// Ballot shape of a poll, matching worker/enums.ts. The verdict type is its own
// type: its options are the verdict words the proposal form pre-fills, and it
// accepts the same single ballot as a single choice poll.

import { ApiError, parseApiErrorPayload } from './apiError';

export type PollType = 'verdict' | 'single_choice' | 'multi_choice';

// The durations offered by the proposal form. The mapping is defined once in
// worker/enums.ts and re-exported here so the form and the Worker agree.
export type PollDuration = 'none' | '1d' | '3d' | '7d' | '14d' | '1m' | '6m' | '1y';

export const POLL_DURATION_DAYS: Readonly<Record<PollDuration, number | null>> = {
  none: null,
  '1d': 1,
  '3d': 3,
  '7d': 7,
  '14d': 14,
  '1m': 30,
  '6m': 180,
  '1y': 365
};

export const POLL_DURATIONS: ReadonlyArray<PollDuration> = [
  'none',
  '1d',
  '3d',
  '7d',
  '14d',
  '1m',
  '6m',
  '1y'
];

// i18n keys of the duration labels shown in the form.
export const DURATION_LABEL_KEYS: Readonly<Record<PollDuration, string>> = {
  none: 'durationNone',
  '1d': 'duration1d',
  '3d': 'duration3d',
  '7d': 'duration7d',
  '14d': 'duration14d',
  '1m': 'duration1m',
  '6m': 'duration6m',
  '1y': 'duration1y'
};

// Limits shared with the Worker-side validation.
export const MIN_POLL_OPTIONS = 2;
export const MAX_POLL_OPTIONS = 7;
export const MAX_OPTION_LABEL_LENGTH = 80;

// Reasons a visitor can report a poll, in the order they are shown.
export type ReportReason =
  | 'spam'
  | 'inappropriate'
  | 'misleading'
  | 'copyright'
  | 'personal_info'
  | 'harassment'
  | 'illegal'
  | 'other';

export const REPORT_REASONS: readonly ReportReason[] = [
  'spam',
  'inappropriate',
  'misleading',
  'copyright',
  'personal_info',
  'harassment',
  'illegal',
  'other'
];

export interface PollViewCounts {
  total: number;
  last7Days: number;
}

export interface PollOption {
  id: number;
  /** The option text the submitter wrote. */
  label: string;
  position: number;
  count?: number;
}

// The single results shape returned for every poll: the ballot total and one
// entry per option, or `options: null` below the display threshold. Each option
// carries its own `count`.
export interface PollResults {
  pollType?: PollType;
  ballots: number;
  hidden: boolean;
  threshold: number;
  options: PollOption[] | null;
}

export interface PollTopicRef {
  slug: string;
  name: string;
}

// A poll adjacent to the one shown, for the detail page's previous/next links.
export interface PollNeighbor {
  id: number;
  /** The public number the link points at; the id stays internal. */
  number: number;
  title: string;
}

export interface PollSummary {
  id: number;
  /** The public number a visitor sees; the primary key stays internal. */
  number: number;
  title: string;
  description: string | null;
  mode: 'deadline' | 'evergreen';
  pollType?: PollType;
  options?: PollOption[];
  start_at: string | null;
  end_at?: string | null;
  status: 'open' | 'closed' | 'archived';
  /** The poll's topic, or null/absent when it is untopicalized. */
  topic?: PollTopicRef | null;
  /** The older/newer public poll, or null when there is none that way. */
  prev?: PollNeighbor | null;
  next?: PollNeighbor | null;
}

// An enabled topic from `GET /api/topics`, with its name for each locale
// and the number of open polls it holds.
export interface PollTopic {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  position: number;
  names: { en: string; 'zh-CN': string; 'zh-TW': string };
  count: number;
}

export interface PollWithStats {
  poll: PollSummary;
  stats: PollResults & {
    pollId: number;
    voted: boolean;
  };
  views: PollViewCounts | null;
}

export interface VoteResponse extends PollResults {
  ok: boolean;
  message: string;
  voted: boolean;
  alreadyVoted?: boolean;
}

export interface VoteStatusResponse {
  pollId: number;
  voted: boolean;
  optionIds: number[];
}

export interface CommentsResponse {
  pollId: number;
  page: number;
  pageSize: number;
  total: number;
  comments: Array<{ id: string | null; comment: string; createdAt: string }>;
}

// Parses an error body, keeping the raw text when it is not JSON so a plain-text
// failure still reaches the caller.
function readErrorPayload(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text.trim();
  }
}

export async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {})
    },
    ...init
  });

  if (!response.ok) {
    const parsed = parseApiErrorPayload(readErrorPayload(await response.text()));
    // The message keeps the API's English text so a legacy response can still be
    // mapped back to a code; `code` and `params` drive the localized text.
    throw new ApiError(parsed.message, {
      code: parsed.code,
      params: parsed.params,
      status: response.status
    });
  }

  return response.json() as Promise<T>;
}

export async function getStats(pollId: number): Promise<PollResults & {
  pollId: number;
  voted: boolean;
}> {
  return fetchJson(`/api/stats/${pollId}`);
}

export async function getPolls(page: number, pageSize: number, query = '', topic = ''): Promise<{
  polls: PollWithStats[];
  page: number;
  pageSize: number;
  total: number;
  query: string;
  totalPolls: number;
  totalVotes: number;
}> {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (query) params.set('q', query);
  if (topic) params.set('topic', topic);
  return fetchJson(`/api/polls?${params}`);
}

// The enabled topics and the number of open polls overall, for the home page
// chip row.
export async function getTopics(): Promise<{ topics: PollTopic[]; total: number }> {
  return fetchJson('/api/topics');
}

export async function getPoll(pollId: number): Promise<{ poll: PollSummary; views: PollViewCounts | null }> {
  return fetchJson(`/api/polls/${pollId}`);
}

// Records one view for a poll at most once per tab session. View counting is
// best-effort: a failure is never surfaced to the visitor.
export async function recordViewOnce(pollId: number): Promise<void> {
  try {
    if (sessionStorage.getItem(`chinapoll.viewed.${pollId}`) === '1') return;
    sessionStorage.setItem(`chinapoll.viewed.${pollId}`, '1');
  } catch {
    // Ignore storage failures and still record the view.
  }
  try {
    await fetch(`/api/polls/${pollId}/view`, { method: 'POST' });
  } catch {
    // View counting is best-effort; the page must not fail because of it.
  }
}

// Reports a poll or a comment. Both share one endpoint shape and one rate-limit
// budget; only the path differs, so the caller names the target with `pollId` or
// `commentId`.
export async function submitReport(payload: {
  pollId?: number;
  commentId?: string;
  reason: ReportReason;
  note?: string;
  turnstileToken?: string;
}): Promise<{ ok: boolean }> {
  const path = payload.commentId
    ? `/api/comments/${encodeURIComponent(payload.commentId)}/report`
    : `/api/polls/${payload.pollId}/report`;
  return fetchJson(path, {
    method: 'POST',
    body: JSON.stringify({
      reason: payload.reason,
      note: payload.note || undefined,
      turnstileToken: payload.turnstileToken || undefined
    })
  });
}

export function hasReportedLocally(pollId: number): boolean {
  try {
    return localStorage.getItem(`chinapoll.reported.${pollId}`) === '1';
  } catch {
    return false;
  }
}

export function markReportedLocally(pollId: number): void {
  try {
    localStorage.setItem(`chinapoll.reported.${pollId}`, '1');
  } catch {
    // Ignore storage failures.
  }
}

// A reported comment is remembered by its public id, so this browser sees the
// confirmation note in that comment's menu without another request.
export function hasCommentReportedLocally(publicId: string): boolean {
  try {
    return localStorage.getItem(`chinapoll.reported-comment.${publicId}`) === '1';
  } catch {
    return false;
  }
}

export function markCommentReportedLocally(publicId: string): void {
  try {
    localStorage.setItem(`chinapoll.reported-comment.${publicId}`, '1');
  } catch {
    // Ignore storage failures.
  }
}

export async function getComments(pollId: number, page: number, pageSize: number): Promise<CommentsResponse> {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  return fetchJson(`/api/comments/${pollId}?${params}`);
}

export async function submitComment(pollId: number, comment: string): Promise<{ id: string }> {
  return fetchJson<{ ok: boolean; id: string }>('/api/comments', {
    method: 'POST',
    body: JSON.stringify({ pollId, comment })
  });
}

export async function submitVote(payload: {
  pollId: number;
  tokenHash: string;
  optionIds: number[];
  turnstileToken?: string;
}): Promise<VoteResponse> {
  return fetchJson('/api/vote', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export async function getVoteStatus(pollId: number, tokenHash: string): Promise<VoteStatusResponse> {
  return fetchJson('/api/vote/status', {
    method: 'POST',
    body: JSON.stringify({ pollId, tokenHash })
  });
}

export function hasVotedLocally(pollId: number, tokenHash: string): boolean {
  return localStorage.getItem(`chinapoll.voted.${pollId}`) === tokenHash;
}

export function markVotedLocally(pollId: number, tokenHash: string): void {
  localStorage.setItem(`chinapoll.voted.${pollId}`, tokenHash);
}

export async function submitProposal(payload: {
  title: string;
  description?: string;
  pollType: PollType;
  duration: PollDuration;
  options: Array<{ position: number; label: string }>;
  /** The topic slug the submitter chose; omitted when none was selected. */
  topic?: string;
}): Promise<{ ok: boolean; message: string; pollId: number; status?: 'open' | 'pending' }> {
  return fetchJson('/api/proposal', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

// The base vote token identifies a browser. It is stored together with a
// creation time and rotated after 30 days so it cannot be used as a long-term
// identifier.
const TOKEN_STORAGE_KEY = 'chinapoll.vote-token';
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function createToken(): string {
  const stored = localStorage.getItem(TOKEN_STORAGE_KEY);
  if (stored) {
    try {
      const parsed: unknown = JSON.parse(stored);
      if (typeof parsed === 'object' && parsed !== null
        && typeof (parsed as { token?: unknown }).token === 'string'
        && typeof (parsed as { createdAt?: unknown }).createdAt === 'number') {
        const { token, createdAt } = parsed as { token: string; createdAt: number };
        if (Date.now() - createdAt < TOKEN_TTL_MS) return token;
      }
    } catch {
      // Fall through and mint a fresh token when the stored value is unusable.
    }
  }

  const token = crypto.randomUUID();
  localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify({ token, createdAt: Date.now() }));
  return token;
}

export async function hashToken(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
