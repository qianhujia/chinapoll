export type VoteOption = 'approve' | 'oppose' | 'neutral';

export interface PollSummary {
  id: number;
  title: string;
  description: string | null;
  mode: 'deadline' | 'evergreen';
  start_at: string | null;
  end_at?: string | null;
  status: 'open' | 'closed' | 'archived';
}

export interface PollWithStats {
  poll: PollSummary;
  stats: { pollId: number; counts: Record<VoteOption, number>; voted: boolean };
}

export interface VoteResponse {
  ok: boolean;
  message: string;
  counts: Record<VoteOption, number>;
  voted: boolean;
  alreadyVoted?: boolean;
}

export interface VoteStatusResponse {
  pollId: number;
  voted: boolean;
  option: VoteOption | null;
}

export interface CommentsResponse {
  pollId: number;
  page: number;
  pageSize: number;
  total: number;
  comments: Array<{ id: number; comment: string; createdAt: string }>;
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

export async function getStats(pollId: number): Promise<{ pollId: number; counts: Record<VoteOption, number>; voted: boolean }> {
  return fetchJson(`/api/stats/${pollId}`);
}

export async function getPolls(page: number, pageSize: number): Promise<{
  polls: PollWithStats[];
  page: number;
  pageSize: number;
  total: number;
  totalPolls: number;
  totalVotes: number;
}> {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  return fetchJson(`/api/polls?${params}`);
}

export async function getPoll(pollId: number): Promise<PollSummary> {
  const response = await fetchJson<{ poll: PollSummary }>(`/api/polls/${pollId}`);
  return response.poll;
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
  option: VoteOption;
  ipBucket?: string;
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
  mode: 'deadline' | 'evergreen';
  startAt?: string;
  endAt?: string;
  email?: string;
}): Promise<{ ok: boolean; message: string; pollId: number; submitter?: string }> {
  return fetchJson('/api/proposal', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export async function claimProposal(pollId: string, email: string): Promise<{ ok: boolean; pollId: number; submitter: string }> {
  return fetchJson('/api/proposal/claim', {
    method: 'POST',
    body: JSON.stringify({ pollId, email })
  });
}

export function createToken(): string {
  const storageKey = 'chinapoll.vote-token';
  const storedToken = localStorage.getItem(storageKey);
  if (storedToken) return storedToken;

  const token = crypto.randomUUID();
  localStorage.setItem(storageKey, token);
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
