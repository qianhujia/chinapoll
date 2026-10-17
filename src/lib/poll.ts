// Ballot shape of a poll, matching worker/enums.ts. There is no separate verdict
// type: a "verdict" poll is a single choice poll whose options are the words
// Approve, Neutral, and Oppose.
export type PollType = 'single_choice' | 'multi_choice';

// The durations offered by the proposal form. The mapping is defined once in
// worker/enums.ts and re-exported here so the form and the Worker agree.
export type PollDuration = 'none' | '1d' | '3d' | '7d' | '14d' | '1m' | '1y';

export const POLL_DURATION_DAYS: Readonly<Record<PollDuration, number | null>> = {
  none: null,
  '1d': 1,
  '3d': 3,
  '7d': 7,
  '14d': 14,
  '1m': 30,
  '1y': 365
};

export const POLL_DURATIONS: ReadonlyArray<PollDuration> = [
  'none',
  '1d',
  '3d',
  '7d',
  '14d',
  '1m',
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

export interface PollSummary {
  id: number;
  title: string;
  description: string | null;
  mode: 'deadline' | 'evergreen';
  pollType?: PollType;
  options?: PollOption[];
  start_at: string | null;
  end_at?: string | null;
  status: 'open' | 'closed' | 'archived';
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

export async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {})
    },
    ...init
  });

  if (!response.ok) {
    const responseBody = await response.text();
    let message = '';
    try {
      const errorBody: unknown = JSON.parse(responseBody);
      if (typeof errorBody === 'object' && errorBody !== null && 'message' in errorBody
        && typeof errorBody.message === 'string') {
        message = errorBody.message;
      }
    } catch {
      message = responseBody.trim();
    }
    throw new Error(message
      ? `${message} (${response.status})`
      : `Request failed: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

export async function getStats(pollId: number): Promise<PollResults & {
  pollId: number;
  voted: boolean;
}> {
  return fetchJson(`/api/stats/${pollId}`);
}

export async function getPolls(page: number, pageSize: number, query = ''): Promise<{
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
  return fetchJson(`/api/polls?${params}`);
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

export async function submitReport(payload: {
  pollId: number;
  reason: ReportReason;
  note?: string;
  turnstileToken?: string;
}): Promise<{ ok: boolean }> {
  return fetchJson(`/api/polls/${payload.pollId}/report`, {
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

export async function getComments(pollId: number, page: number, pageSize: number): Promise<CommentsResponse> {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  return fetchJson(`/api/comments/${pollId}?${params}`);
}

export async function submitComment(pollId: number, comment: string): Promise<void> {
  await fetchJson<{ ok: boolean }>('/api/comments', {
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

// Poll ids the browser submitted, so the account page can list "my polls" even
// though the server stores only a one-way owner hash.
const MY_POLLS_KEY = 'chinapoll.my-polls';
const MAX_MY_POLLS = 100;

export function rememberMyPoll(pollId: number): void {
  const ids = getMyPollIds();
  if (!ids.includes(pollId)) ids.push(pollId);
  try {
    localStorage.setItem(MY_POLLS_KEY, JSON.stringify(ids.slice(-MAX_MY_POLLS)));
  } catch {
    // Ignore storage failures (for example a full or blocked localStorage).
  }
}

export function getMyPollIds(): number[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(MY_POLLS_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((value): value is number => typeof value === 'number') : [];
  } catch {
    return [];
  }
}

export function forgetMyPoll(pollId: number): void {
  const ids = getMyPollIds().filter((id) => id !== pollId);
  try {
    localStorage.setItem(MY_POLLS_KEY, JSON.stringify(ids));
  } catch {
    // Ignore storage failures.
  }
}

export async function hashToken(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
