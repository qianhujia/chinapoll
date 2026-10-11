// Hourly maintenance tasks run by the public Worker's scheduled handler.
//
// Responsibilities:
//   * write a signed snapshot for every open poll (the hash chain in
//     worker/services/snapshot.ts makes published counts tamper-evident);
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

  // Close deadline polls whose end time has passed and stamp closed_at.
  await env.DB.prepare(
    `UPDATE polls SET status = ?, closed_at = ?, updated_at = unixepoch()
     WHERE status = ? AND mode = ? AND end_at IS NOT NULL AND end_at <= ?`
  ).bind(PollStatus.Closed, now, PollStatus.Open, PollMode.Deadline, now).run();

  await writeSnapshots(env, tsHour);

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

// Writes one snapshot per open poll in three queries total (poll ids, counts,
// previous hashes) plus a single batch insert, instead of three queries per poll.
async function writeSnapshots(env: MaintenanceEnv, tsHour: number): Promise<void> {
  const polls = await env.DB.prepare(
    'SELECT id FROM polls WHERE status = ?'
  ).bind(PollStatus.Open).all<{ id: number }>();
  const pollIds = (polls.results ?? []).map((row) => Number(row.id));
  if (pollIds.length === 0) return;

  const counts = new Map<number, { approve: number; oppose: number; neutral: number }>();
  const countsRows = await env.DB.prepare(
    `SELECT poll_id, option, COUNT(*) AS count
     FROM votes WHERE poll_id IN (SELECT id FROM polls WHERE status = ?)
     GROUP BY poll_id, option`
  ).bind(PollStatus.Open).all<{ poll_id: number; option: number; count: number }>();
  for (const row of countsRows.results ?? []) {
    const pollId = Number(row.poll_id);
    const entry = counts.get(pollId) ?? { approve: 0, oppose: 0, neutral: 0 };
    if (Number(row.option) === 1) entry.approve = Number(row.count);
    else if (Number(row.option) === 2) entry.oppose = Number(row.count);
    else if (Number(row.option) === 3) entry.neutral = Number(row.count);
    counts.set(pollId, entry);
  }

  const previous = new Map<number, string>();
  const hashRows = await env.DB.prepare(
    `SELECT s.poll_id, s.hash
     FROM stats_snapshots s
     JOIN (SELECT poll_id, MAX(ts_hour) AS ts_hour FROM stats_snapshots
           WHERE poll_id IN (SELECT id FROM polls WHERE status = ?)
           GROUP BY poll_id) latest
       ON latest.poll_id = s.poll_id AND latest.ts_hour = s.ts_hour`
  ).bind(PollStatus.Open).all<{ poll_id: number; hash: string }>();
  for (const row of hashRows.results ?? []) {
    previous.set(Number(row.poll_id), row.hash);
  }

  const insert = env.DB.prepare(
    `INSERT INTO stats_snapshots (poll_id, ts_hour, approve, oppose, neutral, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(poll_id, ts_hour) DO NOTHING`
  );

  const statements = [];
  for (const pollId of pollIds) {
    const snapshot = await makeSnapshot({
      pollId,
      tsHour,
      counts: counts.get(pollId) ?? { approve: 0, oppose: 0, neutral: 0 },
      prevHash: previous.get(pollId) ?? null
    });
    statements.push(insert.bind(
      snapshot.pollId, snapshot.tsHour, snapshot.approve, snapshot.oppose,
      snapshot.neutral, snapshot.prevHash, snapshot.hash
    ));
  }

  await env.DB.batch(statements);
}