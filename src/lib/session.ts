import { fetchJson } from './poll';

export interface UserPublic {
  id: number;
  username: string;
  createdAt: string;
}

export interface UserPoll {
  id: number;
  /** The public number, or null while the poll is still pending. */
  number: number | null;
  title: string | null;
  description: string | null;
  mode: 'deadline' | 'evergreen';
  status: 'open' | 'closed' | 'archived' | 'pending';
  startAt: string | null;
  endAt: string | null;
  createdAt: string;
}

// The client remembers the poll ids it submitted; the server answers "my polls"
// only for ids whose owner hash matches.
interface PollsResponse {
  polls: UserPoll[];
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

export async function registerUser(username: string, password: string, turnstileToken = ''): Promise<RegistrationResult> {
  const result = await fetchJson<{ ok: boolean; user: UserPublic; recoveryCode: string }>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password, turnstileToken })
  });
  currentUser = await loadSession();
  return { user: result.user, recoveryCode: result.recoveryCode ?? '' };
}

// Resets the password with a single-use recovery code and returns a fresh code.
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

// Generates a fresh recovery code and returns the plaintext code once. The
// current password is required so a hijacked session cannot lock the owner out.
export async function regenerateRecoveryCode(currentPassword: string): Promise<string> {
  const result = await fetchJson<{ ok: boolean; recoveryCode: string }>('/api/user/recovery-code', {
    method: 'POST',
    body: JSON.stringify({ currentPassword })
  });
  return result.recoveryCode ?? '';
}

// Deletes the account after confirming the password. Content stays but carries
// no account link.
export async function deleteAccount(currentPassword: string): Promise<void> {
  await fetchJson<{ ok: boolean }>('/api/user/account', {
    method: 'DELETE',
    body: JSON.stringify({ currentPassword })
  });
  currentUser = null;
}

export async function loginUser(username: string, password: string, turnstileToken = ''): Promise<UserPublic> {
  const result = await fetchJson<{ ok: boolean; user: UserPublic }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password, turnstileToken })
  });
  currentUser = await loadSession();
  return result.user;
}

export async function logoutUser(): Promise<void> {
  await fetchJson<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
  currentUser = null;
}

// Signs every device out of the account, including the browser making the call,
// and clears the cached session.
export async function logoutAllDevices(): Promise<void> {
  await fetchJson<{ ok: boolean }>('/api/user/logout-all', { method: 'POST' });
  currentUser = null;
}

// Lists the remembered poll ids that the account actually owns.
export async function getUserPolls(ids: number[]): Promise<UserPoll[]> {
  if (ids.length === 0) return [];
  const params = new URLSearchParams({ ids: ids.join(',') });
  const result = await fetchJson<PollsResponse>(`/api/user/polls?${params}`);
  return result.polls ?? [];
}

export interface UserComment {
  /** The comment's random public id. */
  id: string;
  pollId: number;
  /** The public number of the poll the comment belongs to. */
  pollNumber: number | null;
  pollTitle: string | null;
  comment: string;
  createdAt: string;
}

// The client remembers the comment ids it posted; the server answers "my comments"
// only for ids whose owner hash matches.
interface CommentsResponse {
  comments: UserComment[];
}

// Lists the remembered comment ids that the account actually posted, newest first.
//
// `created_at` is coarsened to the hour, so comments posted in the same hour share a
// timestamp and the server cannot tell them apart. The remembered ids are in posting
// order, so they are reversed here: the dashboard lists the newest comment first.
export async function getUserComments(ids: string[]): Promise<UserComment[]> {
  if (ids.length === 0) return [];
  const params = new URLSearchParams({ ids: ids.join(',') });
  const result = await fetchJson<CommentsResponse>(`/api/user/comments?${params}`);
  const byId = new Map((result.comments ?? []).map((comment) => [comment.id, comment]));
  return [...ids].reverse().flatMap((id) => {
    const comment = byId.get(id);
    return comment ? [comment] : [];
  });
}

export async function deleteUserComment(id: string): Promise<void> {
  await fetchJson<{ ok: boolean }>(`/api/user/comments/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function closeUserPoll(pollId: number): Promise<void> {
  await fetchJson<{ ok: boolean }>(`/api/user/polls/${pollId}/close`, { method: 'POST' });
}

export async function deleteUserPoll(pollId: number): Promise<void> {
  await fetchJson<{ ok: boolean }>(`/api/user/polls/${pollId}`, { method: 'DELETE' });
}