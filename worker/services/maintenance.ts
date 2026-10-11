// Hourly maintenance tasks run by the public Worker's scheduled handler.
//
// Responsibilities:
//   * write a signed snapshot for every open poll and a terminal snapshot when a
//     poll closes (the hash chain in worker/services/snapshot.ts makes published
//     counts tamper-evident), so the chain always ends on the final result;
//   * advance the poll lifecycle (open, close, archive);
//   * purge vote rows thirty days after a poll closed and drop expired sessions
//     and stale account-cap rows.
//
// Retention is keyed on `polls.closed_at`, not `updated_at`, so editing a closed
// poll does not restart its retention clock.

import { PollMode, PollStatus } from '../enums';
import { makeSnapshot } from './snapshot';

interface MaintenanceEnv {
  DB: D1Database;
}

const RETENTION_SECONDS = 30 * 24 * 60 * 60;
const ATTEMPT_RETENTION_SECONDS = 30 * 24 * 60 * 60;
// A poll that closed within this window still needs its terminal snapshot
// written if an earlier close path could not write one.
const FINAL_SNAPSHOT_WINDOW_SECONDS = 3600;

// Returns the start of the current UTC hour as Unix seconds. Close paths use it
// as the snapshot `ts_hour` so the terminal record lands in the closing hour.
export function currentHour(): number {
  const now = Math.floor(Date.now() / 1000);
  return now - (now % 3600);
}

// Selects the polls that need a snapshot this hour: every open poll, plus any
// poll that closed within the final-snapshot window and does not yet have a
// terminal snapshot (a safety net for a close path that could not write one).
const SNAPSHOT_POLLS_SQL = `SELECT id, status FROM polls
   WHERE status = ?
      OR (status = ? AND closed_at IS NOT NULL AND closed_at >= ?
          AND NOT EXISTS (SELECT 1 FROM stats_snapshots s
                          WHERE s.poll_id = polls.id AND s.final = 1))`;

// Inserts a snapshot, or refreshes the row for the same poll and hour. The
// upsert keeps the terminal marker and the counts correct when an open snapshot
// written earlier in the same hour is followed by a close.
const INSERT_SNAPSHOT_SQL = `INSERT INTO stats_snapshots
   (poll_id, ts_hour, approve, oppose, neutral, prev_hash, hash, final)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(poll_id, ts_hour) DO UPDATE SET
     approve = excluded.approve,
     oppose = excluded.oppose,
     neutral = excluded.neutral,
     prev_hash = excluded.prev_hash,
     hash = excluded.hash,
     final = excluded.final`;

interface Counts {
  approve: number;
  oppose: number;
  neutral: number;
}

function emptyCounts(): Counts {
  return { approve: 0, oppose: 0, neutral: 0 };
}

function applyCount(counts: Counts, option: number, count: number): void {
  if (option === 1) counts.approve = count;
  else if (option === 2) counts.oppose = count;
  else if (option === 3) counts.neutral = count;
}

export async function runMaintenanceTasks(env: MaintenanceEnv): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const tsHour = now - (now % 3600);
  const cutoff = now - RETENTION_SECONDS;

  // Open approved deadline polls whose start time has arrived. Approval records
  // reviewed_at, so approval and opening stay distinct.
  await env.DB.prepare(
    `UPDATE polls SET status = ?, updated_at = unixepoch()
     WHERE status = ? AND mode = ? AND reviewed_at IS NOT NULL
       AND start_at IS NOT NULL AND start_at <= ?`
  ).bind(PollStatus.Open, PollStatus.Pending, PollMode.Deadline, now).run();

  // Snapshot every poll that is currently open (and any recently closed poll
  // whose terminal snapshot is still missing) before the close step runs, so a
  // poll that closes this hour has already been captured.
  await writeSnapshots(env, tsHour, now);

  // Close deadline polls whose end time has passed and stamp closed_at.
  const closing = await env.DB.prepare(
    `SELECT id FROM polls
     WHERE status = ? AND mode = ? AND end_at IS NOT NULL AND end_at <= ?`
  ).bind(PollStatus.Open, PollMode.Deadline, now).all<{ id: number }>();

  await env.DB.prepare(
    `UPDATE polls SET status = ?, closed_at = ?, updated_at = unixepoch()
     WHERE status = ? AND mode = ? AND end_at IS NOT NULL AND end_at <= ?`
  ).bind(PollStatus.Closed, now, PollStatus.Open, PollMode.Deadline, now).run();

  // Write the terminal snapshot for every poll this run just closed, so the
  // chain ends on the poll's real final counts.
  for (const row of closing.results ?? []) {
    await writeSnapshotForPoll(env, Number(row.id), tsHour, true);
  }

  // Purge votes thirty days after a poll closed, then archive the same polls so
  // both steps share one schedule keyed on closed_at.
  await env.DB.prepare(
    `DELETE FROM votes WHERE poll_id IN (
       SELECT id FROM polls WHERE status IN (?, ?) AND closed_at IS NOT NULL AND closed_at <= ?
     )`
  ).bind(PollStatus.Closed, PollStatus.Archived, cutoff).run();

  await env.DB.prepare(
    `UPDATE polls SET status = ?, updated_at = unixepoch()
     WHERE status = ? AND closed_at IS NOT NULL AND closed_at <= ?`
  ).bind(PollStatus.Archived, PollStatus.Closed, cutoff).run();

  await env.DB.batch([
    env.DB.prepare('DELETE FROM user_sessions WHERE expires_at <= ?').bind(now),
    env.DB.prepare('DELETE FROM auth_attempts WHERE created_at < ?').bind(now - ATTEMPT_RETENTION_SECONDS)
  ]);
}

// Writes one snapshot per poll that needs one in three queries total (poll ids,
// counts, previous hashes) plus a single batch insert, instead of three queries
// per poll.
async function writeSnapshots(env: MaintenanceEnv, tsHour: number, now: number): Promise<void> {
  const polls = await env.DB.prepare(SNAPSHOT_POLLS_SQL)
    .bind(PollStatus.Open, PollStatus.Closed, now - FINAL_SNAPSHOT_WINDOW_SECONDS)
    .all<{ id: number; status: number }>();
  const entries = (polls.results ?? []).map((row) => ({
    id: Number(row.id),
    final: Number(row.status) === PollStatus.Closed
  }));
  if (entries.length === 0) return;

  const pollIds = entries.map((entry) => entry.id);
  const placeholders = pollIds.map(() => '?').join(', ');

  const counts = new Map<number, Counts>();
  const countsRows = await env.DB.prepare(
    `SELECT poll_id, option, COUNT(*) AS count
     FROM votes WHERE poll_id IN (${placeholders})
     GROUP BY poll_id, option`
  ).bind(...pollIds).all<{ poll_id: number; option: number; count: number }>();
  for (const row of countsRows.results ?? []) {
    const pollId = Number(row.poll_id);
    const entry = counts.get(pollId) ?? emptyCounts();
    applyCount(entry, Number(row.option), Number(row.count));
    counts.set(pollId, entry);
  }

  const previous = new Map<number, string>();
  const hashRows = await env.DB.prepare(
    `SELECT s.poll_id, s.hash
     FROM stats_snapshots s
     JOIN (SELECT poll_id, MAX(ts_hour) AS ts_hour FROM stats_snapshots
           WHERE poll_id IN (${placeholders}) AND ts_hour < ?
           GROUP BY poll_id) latest
       ON latest.poll_id = s.poll_id AND latest.ts_hour = s.ts_hour`
  ).bind(...pollIds, tsHour).all<{ poll_id: number; hash: string }>();
  for (const row of hashRows.results ?? []) {
    previous.set(Number(row.poll_id), row.hash);
  }

  const insert = env.DB.prepare(INSERT_SNAPSHOT_SQL);

  const statements: D1PreparedStatement[] = [];
  for (const entry of entries) {
    const snapshot = await makeSnapshot({
      pollId: entry.id,
      tsHour,
      counts: counts.get(entry.id) ?? emptyCounts(),
      prevHash: previous.get(entry.id) ?? null
    });
    statements.push(insert.bind(
      snapshot.pollId, snapshot.tsHour, snapshot.approve, snapshot.oppose,
      snapshot.neutral, snapshot.prevHash, snapshot.hash, entry.final ? 1 : 0
    ));
  }

  await env.DB.batch(statements);
}

// Writes (or refreshes) the snapshot for a single poll at one hour. Every close
// path calls it with `isFinal = true` so the chain ends on the final counts even
// when a poll closes between the hourly runs.
export async function writeSnapshotForPoll(
  env: MaintenanceEnv,
  pollId: number,
  tsHour: number,
  isFinal: boolean
): Promise<void> {
  const counts = emptyCounts();
  const countsRows = await env.DB.prepare(
    'SELECT option, COUNT(*) AS count FROM votes WHERE poll_id = ? GROUP BY option'
  ).bind(pollId).all<{ option: number; count: number }>();
  for (const row of countsRows.results ?? []) {
    applyCount(counts, Number(row.option), Number(row.count));
  }

  const previous = await env.DB.prepare(
    `SELECT hash FROM stats_snapshots
     WHERE poll_id = ? AND ts_hour < ? ORDER BY ts_hour DESC LIMIT 1`
  ).bind(pollId, tsHour).first<{ hash: string }>();

  const snapshot = await makeSnapshot({
    pollId,
    tsHour,
    counts,
    prevHash: previous?.hash ?? null
  });

  await env.DB.prepare(INSERT_SNAPSHOT_SQL).bind(
    snapshot.pollId, snapshot.tsHour, snapshot.approve, snapshot.oppose,
    snapshot.neutral, snapshot.prevHash, snapshot.hash, isFinal ? 1 : 0
  ).run();
}