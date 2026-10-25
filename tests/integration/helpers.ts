import { env, SELF } from 'cloudflare:test';

export const ORIGIN = 'https://example.com';

// Load every migration eagerly and sort by filename, matching the order wrangler
// applies them. The baseline 0001_initial.sql is immutable; later schema changes
// arrive as new numbered files and are picked up here automatically.
const migrationModules = import.meta.glob('../../migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>;

export const MIGRATIONS: ReadonlyArray<{ name: string; sql: string }> = Object.entries(
  migrationModules
)
  .map(([path, sql]) => ({
    name: path.slice(path.lastIndexOf('/') + 1).replace(/\.sql$/, ''),
    sql
  }))
  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

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
  /** 1 verdict, 2 single choice (default), 3 multiple choice. */
  pollType?: number;
  durationSeconds?: number | null;
}

// Inserts a poll row and returns its id. Mode 2 is evergreen, status 1 is open.
export async function seedPoll(options: SeedPollOptions): Promise<number> {
  const status = options.status ?? 1;
  // The public number is taken when a poll is approved, exactly as the Worker does
  // at the same moment, so a seeded poll behaves like a published one. A pending
  // poll has none.
  const approved = status === 1 || status === 2 || status === 3;
  await env.DB.prepare(
    `INSERT INTO polls (title, description, mode, status, start_at, end_at, closed_at, reviewed_at, poll_type, duration_seconds, number)
     VALUES (?, 'A description that is long enough to pass.', ?, ?, ?, ?, ?, ?, ?, ?,
             CASE WHEN ? THEN (SELECT COALESCE(MAX(number), 0) + 1 FROM polls) ELSE NULL END)`
  ).bind(
    options.title,
    options.mode ?? 2,
    status,
    options.startAt ?? null,
    options.endAt ?? null,
    options.closedAt ?? null,
    options.reviewedAt ?? null,
    options.pollType ?? 2,
    options.durationSeconds ?? null,
    approved ? 1 : 0
  ).run();
  return lastId();
}

// The three labels the Verdict type pre-fills. A verdict poll is a single-answer
// poll whose options the form generates from these words.
export const VERDICT_TEMPLATE_LABELS: ReadonlyArray<string> = ['Approve', 'Neutral', 'Oppose'];

// Inserts a verdict poll with the three default labels, so a test can exercise the
// shape the form produces.
export async function seedVerdictTemplatePoll(
  options: Omit<SeedPollOptions, 'pollType'> = { title: 'Verdict poll' }
): Promise<{ pollId: number; options: Map<number, number> }> {
  const pollId = await seedPoll({ ...options, pollType: 1 });
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

// Posts a ballot through the public API. The mutation helpers all send the Origin
// header a browser sends on a POST, because the Worker refuses a mutation that does
// not come from its own origin.
export function choiceVoteRequest(pollId: number, tokenHash: string, optionIds: number[]): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/vote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ pollId, tokenHash, optionIds })
  });
}

// Posts a ballot carrying the removed legacy `option` label, so a test can check
// that the field is refused now that every ballot reports option IDs.
export function legacyOptionVoteRequest(pollId: number, tokenHash: string, option: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/vote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ pollId, tokenHash, option })
  });
}

// Reads the stored vote status for a token.
export function voteStatusRequest(pollId: number, tokenHash: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/vote/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ pollId, tokenHash })
  });
}

// Submits a poll report through the public API.
export function reportRequest(pollId: number, reason: string, note?: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/polls/${pollId}/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify(note === undefined ? { reason } : { reason, note })
  });
}

// Inserts a comment row with no author mark, so a test can exercise the comment
// APIs without a session. The public id must be the 16 lowercase hex characters
// the comment report route expects.
export async function seedComment(pollId: number, publicId: string, comment = 'A comment worth reporting'): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO comments (poll_id, comment, public_id, author_mark) VALUES (?, ?, ?, NULL)'
  ).bind(pollId, comment, publicId).run();
}

// Submits a comment report through the public API, naming the comment by its
// random public id.
export function commentReportRequest(publicId: string, reason: string, note?: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/comments/${publicId}/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify(note === undefined ? { reason } : { reason, note })
  });
}

// Records a poll view through the public API.
export function viewRequest(pollId: number): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/polls/${pollId}/view`, {
    method: 'POST',
    headers: { origin: ORIGIN }
  });
}
