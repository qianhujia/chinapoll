import { fetchJson } from './poll';

export interface UserPublic {
  id: number;
  username: string;
  createdAt: string;
}

export interface UserPoll {
  id: number;
  title: string | null;
  description: string | null;
  mode: 'deadline' | 'evergreen';
  status: 'open' | 'closed' | 'archived' | 'pending';
  startAt: string | null;
  endAt: string | null;
  createdAt: string;
}

export interface UserComment {
  id: number;
  pollId: number;
  pollTitle: string | null;
  comment: string;
  createdAt: string;
}

interface PollsResponse {
  polls: UserPoll[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

interface CommentsResponse {
  comments: UserComment[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

// The signed-in user is cached in memory so the header and pages can render
// without waiting for another request after the initial session load.
let currentUser: UserPublic | null = null;

export interface RegistrationResult {
  user: UserPublic;
  /** Single-use recovery code, shown to the user once at sign-up. */
  recoveryCode: string;
}

export async function loadSession(): Promise<UserPublic | null> {
  try {
    const result = await fetchJson<{ authenticated: boolean; user: UserPublic | null }>('/api/auth/session');
    currentUser = result.authenticated ? result.user : null;
  } catch {
    currentUser = null;
  }
  return currentUser;
}

export function getCurrentUser(): UserPublic | null {
  return currentUser;
}

export async function registerUser(username: string, password: string): Promise<RegistrationResult> {
  const result = await fetchJson<{ ok: boolean; user: UserPublic; recoveryCode: string }>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  });
  currentUser = await loadSession();
  return { user: result.user, recoveryCode: result.recoveryCode ?? '' };
}

// Resets the password with a single-use recovery code and returns a fresh code.
// The server rotates the code as it consumes it, the whole code set is not left
// empty, and every device is signed out, so the caller must sign in again with
// the new password afterwards.
export async function recoverPassword(username: string, code: string, newPassword: string): Promise<string> {
  const result = await fetchJson<{ ok: boolean; recoveryCode: string }>('/api/auth/recover', {
    method: 'POST',
    body: JSON.stringify({ username, code, newPassword })
  });
  return result.recoveryCode ?? '';
}

// Whether the account currently has an active recovery code.
export async function getRecoveryCodeStatus(): Promise<boolean> {
  const result = await fetchJson<{ configured: boolean }>('/api/user/recovery-code');
  return result.configured === true;
}

// Generates a fresh recovery code and returns the plaintext code once.
export async function regenerateRecoveryCode(): Promise<string> {
  const result = await fetchJson<{ ok: boolean; recoveryCode: string }>('/api/user/recovery-code', {
    method: 'POST'
  });
  return result.recoveryCode ?? '';
}

export async function loginUser(username: string, password: string): Promise<UserPublic> {
  const result = await fetchJson<{ ok: boolean; user: UserPublic }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  });
  currentUser = await loadSession();
  return result.user;
}

export async function logoutUser(): Promise<void> {
  await fetchJson<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
  currentUser = null;
}

export async function getUserPolls(page = 1, pageSize = 20): Promise<PollsResponse> {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  return fetchJson<PollsResponse>(`/api/user/polls?${params}`);
}

export async function getUserComments(page = 1, pageSize = 20): Promise<CommentsResponse> {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  return fetchJson<CommentsResponse>(`/api/user/comments?${params}`);
}

export async function deleteUserComment(commentId: number): Promise<void> {
  await fetchJson<{ ok: boolean }>(`/api/user/comments/${commentId}`, { method: 'DELETE' });
}

export async function closeUserPoll(pollId: number): Promise<void> {
  await fetchJson<{ ok: boolean }>(`/api/user/polls/${pollId}/close`, { method: 'POST' });
}

export async function deleteUserPoll(pollId: number): Promise<void> {
  await fetchJson<{ ok: boolean }>(`/api/user/polls/${pollId}`, { method: 'DELETE' });
}
