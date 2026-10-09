export type VoteOption = 'approve' | 'oppose' | 'neutral';

export interface IssueSummary {
  id: number;
  title: string;
  description: string | null;
  mode: 'deadline' | 'evergreen';
  start_at: string | null;
  end_at?: string | null;
  status: 'open' | 'closed' | 'archived';
}

export interface IssueWithStats {
  issue: IssueSummary;
  stats: { issueId: number; counts: Record<VoteOption, number>; voted: boolean };
}

export interface VoteResponse {
  ok: boolean;
  message: string;
  counts: Record<VoteOption, number>;
  voted: boolean;
  alreadyVoted?: boolean;
}

export interface VoteStatusResponse {
  issueId: number;
  voted: boolean;
  option: VoteOption | null;
}

export interface CommentsResponse {
  issueId: number;
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

export async function getStats(issueId: number): Promise<{ issueId: number; counts: Record<VoteOption, number>; voted: boolean }> {
  return fetchJson(`/api/stats/${issueId}`);
}

export async function getIssues(page: number, pageSize: number): Promise<{
  issues: IssueWithStats[];
  page: number;
  pageSize: number;
  total: number;
  totalVotes: number;
}> {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  return fetchJson(`/api/issues?${params}`);
}

export async function getIssue(issueId: number): Promise<IssueSummary> {
  const response = await fetchJson<{ issue: IssueSummary }>(`/api/issues/${issueId}`);
  return response.issue;
}

export async function getComments(issueId: number, page: number, pageSize: number): Promise<CommentsResponse> {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  return fetchJson(`/api/comments/${issueId}?${params}`);
}

export async function submitComment(issueId: number, comment: string): Promise<void> {
  await fetchJson<{ ok: boolean }>('/api/comments', {
    method: 'POST',
    body: JSON.stringify({ issueId, comment })
  });
}

export async function submitVote(payload: {
  issueId: number;
  tokenHash: string;
  option: VoteOption;
  ipBucket?: string;
}): Promise<VoteResponse> {
  return fetchJson('/api/vote', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export async function getVoteStatus(issueId: number, tokenHash: string): Promise<VoteStatusResponse> {
  return fetchJson('/api/vote/status', {
    method: 'POST',
    body: JSON.stringify({ issueId, tokenHash })
  });
}

export function hasVotedLocally(issueId: number, tokenHash: string): boolean {
  return localStorage.getItem(`chinapoll.voted.${issueId}`) === tokenHash;
}

export function markVotedLocally(issueId: number, tokenHash: string): void {
  localStorage.setItem(`chinapoll.voted.${issueId}`, tokenHash);
}

export async function submitProposal(payload: {
  title: string;
  description?: string;
  mode: 'deadline' | 'evergreen';
  startAt?: string;
  endAt?: string;
  email?: string;
}): Promise<{ ok: boolean; message: string; proposalId: string; submitter?: string }> {
  return fetchJson('/api/proposal', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export async function claimProposal(proposalId: string, email: string): Promise<{ ok: boolean; proposalId: string; submitter: string }> {
  return fetchJson('/api/proposal/claim', {
    method: 'POST',
    body: JSON.stringify({ proposalId, email })
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
