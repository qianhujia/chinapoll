import { env, SELF } from 'cloudflare:test';
import schema from '../../migrations/0001_initial.sql?raw';
import reportsAndViewsSchema from '../../migrations/0002_reports_and_views.sql?raw';
import pollTypesSchema from '../../migrations/0003_poll_types_and_options.sql?raw';
import unifiedSelectionsSchema from '../../migrations/0004_unified_selections.sql?raw';
import { VERDICT_PRESET_KEYS, type PresetKey } from '../../worker/services/pollType';

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
  /** 1 verdict (default), 2 single choice, 3 multi choice. */
  pollType?: number;
  durationSeconds?: number | null;
  /**
   * Preset rows of a verdict poll. Defaults to all three; pass
   * `['approve', 'oppose']` for a poll without a neutral row.
   */
  presets?: PresetKey[];
}

// Inserts a poll row and returns its id. Mode 2 is evergreen, status 1 is open.
// A verdict poll also gets its preset option rows, exactly as the API writes them.
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
    options.pollType ?? 1,
    options.durationSeconds ?? null
  ).run();
  const pollId = await lastId();
  if ((options.pollType ?? 1) === 1) {
    await seedPresets(pollId, options.presets ?? [...VERDICT_PRESET_KEYS]);
  }
  return pollId;
}

// Inserts the preset rows of a verdict poll and returns their ids by preset key.
export async function seedPresets(pollId: number, presetKeys: PresetKey[]): Promise<Map<PresetKey, number>> {
  const ids = new Map<PresetKey, number>();
  const ordered = VERDICT_PRESET_KEYS.filter((key) => presetKeys.includes(key));
  for (const [index, key] of ordered.entries()) {
    await env.DB.prepare(
      "INSERT INTO poll_options (poll_id, position, label, preset_key) VALUES (?, ?, NULL, ?)"
    ).bind(pollId, index + 1, key).run();
    ids.set(key, await lastId());
  }
  return ids;
}

export interface SeedOption {
  position: number;
  label: string;
}

// Inserts the custom option rows of a choice poll and returns their ids by position.
export async function seedOptions(pollId: number, options: SeedOption[]): Promise<Map<number, number>> {
  const ids = new Map<number, number>();
  for (const option of options) {
    await env.DB.prepare(
      'INSERT INTO poll_options (poll_id, position, label, preset_key) VALUES (?, ?, ?, NULL)'
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

// Posts a verdict ballot through the public API.
export function voteRequest(pollId: number, tokenHash: string, option = 'approve'): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/vote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pollId, tokenHash, option })
  });
}

// Posts a choice ballot through the public API.
export function choiceVoteRequest(pollId: number, tokenHash: string, optionIds: number[]): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/vote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pollId, tokenHash, optionIds })
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
