import { env, SELF } from 'cloudflare:test';
import schema from '../../migrations/0001_initial.sql?raw';
import reportsAndViewsSchema from '../../migrations/0002_reports_and_views.sql?raw';
import pollTypesSchema from '../../migrations/0003_poll_types_and_options.sql?raw';
import unifiedSelectionsSchema from '../../migrations/0004_unified_selections.sql?raw';

export const ORIGIN = 'https://example.com';

// Every migration in order, so a test can also apply a prefix of them (for
// example to seed the pre-0004 shape before checking the data copy).
export const MIGRATIONS: ReadonlyArray<{ name: string; sql: string }> = [
  { name: '0001_initial', sql: schema },
  { name: '0002_reports_and_views', sql: reportsAndViewsSchema },
  { name: '0003_poll_types_and_options', sql: pollTypesSchema },
  { name: '0004_unified_selections', sql: unifiedSelectionsSchema }
];

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

// Applies one migration file statement by statement.
export async function runMigrationSql(sql: string): Promise<void> {
  for (const statement of splitStatements(sql)) {
    await env.DB.prepare(statement).run();
  }
}

// Applies every migration to the per-file test database.
export async function applySchema(): Promise<void> {
  for (const migration of MIGRATIONS) {
    await runMigrationSql(migration.sql);
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
  /** 2 single choice (default), 3 multiple choice. */
  pollType?: number;
  durationSeconds?: number | null;
}

// Inserts a poll row and returns its id. Mode 2 is evergreen, status 1 is open.
export async function seedPoll(options: SeedPollOptions): Promise<number> {
  await env.DB.prepare(
    `INSERT INTO polls (title, description, mode, status, start_at, end_at, closed_at, reviewed_at, poll_type, duration_seconds)
     VALUES (?, 'A description that is long enough to pass.', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    options.title,
    options.mode ?? 2,
    options.status ?? 1,
    options.startAt ?? null,
    options.endAt ?? null,
    options.closedAt ?? null,
    options.reviewedAt ?? null,
    options.pollType ?? 2,
    options.durationSeconds ?? null
  ).run();
  return lastId();
}

// The three labels the Verdict template submits. A verdict poll is an ordinary
// single choice poll with these options.
export const VERDICT_TEMPLATE_LABELS: ReadonlyArray<string> = ['Approve', 'Neutral', 'Oppose'];

// Inserts a poll whose options are the three verdict template labels, so a test
// can exercise the shape the template produces.
export async function seedVerdictTemplatePoll(
  options: Omit<SeedPollOptions, 'pollType'> = { title: 'Verdict template poll' }
): Promise<{ pollId: number; options: Map<number, number> }> {
  const pollId = await seedPoll({ ...options, pollType: 2 });
  const ids = await seedOptions(pollId, VERDICT_TEMPLATE_LABELS.map((label, index) => ({
    position: index + 1,
    label
  })));
  return { pollId, options: ids };
}

export interface SeedOption {
  position: number;
  label: string;
}

// Inserts the custom option rows of a poll and returns their ids by position.
export async function seedOptions(pollId: number, options: SeedOption[]): Promise<Map<number, number>> {
  const ids = new Map<number, number>();
  for (const option of options) {
    await env.DB.prepare(
      'INSERT INTO poll_options (poll_id, position, label) VALUES (?, ?, ?)'
    ).bind(pollId, option.position, option.label).run();
    ids.set(option.position, await lastId());
  }
  return ids;
}

// Inserts one ballot row and its selection rows directly, for tests that need
// stored rows without going through the API.
export async function insertBallot(pollId: number, tokenHash: string, optionIds: number[]): Promise<number> {
  const result = await env.DB.prepare(
    'INSERT INTO votes (poll_id, voter_token_hash, created_at) VALUES (?, ?, unixepoch())'
  ).bind(pollId, tokenHash).run();
  const voteId = Number(result.meta.last_row_id);
  if (optionIds.length > 0) {
    await env.DB.batch(optionIds.map((optionId) => env.DB.prepare(
      'INSERT INTO vote_selections (poll_id, vote_id, option_id) VALUES (?, ?, ?)'
    ).bind(pollId, voteId, optionId)));
  }
  return voteId;
}

// Posts a ballot through the public API.
export function choiceVoteRequest(pollId: number, tokenHash: string, optionIds: number[]): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/vote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pollId, tokenHash, optionIds })
  });
}

// Posts a ballot carrying the removed legacy `option` label, so a test can check
// that the field is refused now that every ballot reports option IDs.
export function legacyOptionVoteRequest(pollId: number, tokenHash: string, option: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/vote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pollId, tokenHash, option })
  });
}

// Reads the stored vote status for a token.
export function voteStatusRequest(pollId: number, tokenHash: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/vote/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pollId, tokenHash })
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
