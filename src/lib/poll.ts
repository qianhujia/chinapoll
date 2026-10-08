export type VoteOption = 'approve' | 'oppose' | 'neutral';

export interface IssueSummary {
  id: number;
  title: string;
  mode: 'deadline' | 'evergreen';
  start_at: string;
  end_at?: string | null;
  status: 'open' | 'closed' | 'archived';
}

export interface VoteResponse {
  ok: boolean;
  message: string;
  counts: Record<VoteOption, number>;
  voted: boolean;
  alreadyVoted?: boolean;
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
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

export async function getStats(issueId: number): Promise<{ issueId: number; counts: Record<VoteOption, number>; voted: boolean }> {
  return fetchJson(`/api/stats/${issueId}`);
}

export async function submitVote(payload: {
  issueId: number;
  tokenHash: string;
  option: VoteOption;
  ipBucket?: string;
  comment?: string;
}): Promise<VoteResponse> {
  return fetchJson('/api/vote', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export async function submitProposal(payload: {
  text: string;
  reason?: string;
  expectedDeadline?: string;
  email?: string;
  tokenHash: string;
}): Promise<{ ok: boolean; message: string; proposalId?: string }> {
  return fetchJson('/api/proposal', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export function createToken(): string {
  return crypto.randomUUID();
}

export async function hashToken(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
