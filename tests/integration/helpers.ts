import { env, SELF } from 'cloudflare:test';
import schema from '../../migrations/0001_initial.sql?raw';
import reportsAndViewsSchema from '../../migrations/0002_reports_and_views.sql?raw';

export const ORIGIN = 'https://example.com';

// D1's exec() rejects a batch whose first chunk is only a comment, so comment-only
// lines are stripped and each migration is executed statement by statement. The
// schemas contain no semicolons inside string literals, so splitting on `;` is
// safe here.
function splitStatements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

const schemaStatements = [schema, reportsAndViewsSchema].flatMap(splitStatements);

// Applies every migration to the per-file test database.
export async function applySchema(): Promise<void> {
  for (const statement of schemaStatements) {
    await env.DB.prepare(statement).run();
  }
}

export async function lastId(): Promise<number> {
  const row = await env.DB.prepare('SELECT last_insert_rowid() AS id').first<{ id: number }>();
  return Number(row?.id ?? 0);
}

export interface SeedPollOptions {
  title: string;
  mode?: number;
  status?: number;
  startAt?: number | null;
  endAt?: number | null;
  closedAt?: number | null;
  reviewedAt?: number | null;
}

// Inserts a poll row and returns its id. Mode 2 is evergreen, status 1 is open.
export async function seedPoll(options: SeedPollOptions): Promise<number> {
  await env.DB.prepare(
    `INSERT INTO polls (title, description, mode, status, start_at, end_at, closed_at, reviewed_at)
     VALUES (?, 'A description that is long enough to pass.', ?, ?, ?, ?, ?, ?)`
  ).bind(
    options.title,
    options.mode ?? 2,
    options.status ?? 1,
    options.startAt ?? null,
    options.endAt ?? null,
    options.closedAt ?? null,
    options.reviewedAt ?? null
  ).run();
  return lastId();
}

// Posts a vote for a poll through the public API.
export function voteRequest(pollId: number, tokenHash: string, option = 'approve'): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/vote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pollId, tokenHash, option })
  });
}

// Submits a poll report through the public API.
export function reportRequest(pollId: number, reason: string, note?: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/polls/${pollId}/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(note === undefined ? { reason } : { reason, note })
  });
}

// Records a poll view through the public API.
export function viewRequest(pollId: number): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/polls/${pollId}/view`, { method: 'POST' });
}
