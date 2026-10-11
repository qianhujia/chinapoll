// Hourly maintenance tasks run by the public Worker's scheduled handler.
//
// Responsibilities:
//   * write a signed snapshot for every open poll (the hash chain in
//     worker/services/snapshot.ts makes published counts tamper-evident);
//   * advance the poll lifecycle (open, close, archive);
//   * purge vote rows thirty days after a poll closes and drop expired sessions
//     and stale account-cap rows.

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

  // Close deadline polls whose end time has passed.
  await env.DB.prepare(
    `UPDATE polls SET status = ?, updated_at = unixepoch()
     WHERE status = ? AND mode = ? AND end_at IS NOT NULL AND end_at <= ?`
  ).bind(PollStatus.Closed, PollStatus.Open, PollMode.Deadline, now).run();

  await writeSnapshots(env, tsHour);

  // Purge votes thirty days after a poll closed, then archive the same polls so
  // both happen on the same schedule.
  await env.DB.prepare(
    `DELETE FROM votes WHERE poll_id IN (
       SELECT id FROM polls WHERE status IN (?, ?) AND updated_at <= ?
     )`
  ).bind(PollStatus.Closed, PollStatus.Archived, cutoff).run();

  await env.DB.prepare(
    `UPDATE polls SET status = ?, updated_at = unixepoch()
     WHERE status = ? AND updated_at <= ?`
  ).bind(PollStatus.Archived, PollStatus.Closed, cutoff).run();

  await env.DB.batch([
    env.DB.prepare('DELETE FROM user_sessions WHERE expires_at <= ?').bind(now),
    env.DB.prepare('DELETE FROM auth_attempts WHERE created_at < ?').bind(now - ATTEMPT_RETENTION_SECONDS)
  ]);
}

async function writeSnapshots(env: MaintenanceEnv, tsHour: number): Promise<void> {
  const polls = await env.DB.prepare(
    'SELECT id FROM polls WHERE status = ?'
  ).bind(PollStatus.Open).all<{ id: number }>();

  for (const { id: pollId } of polls.results ?? []) {
    const counts = await env.DB.prepare(
      `SELECT COALESCE(SUM(CASE WHEN option = 1 THEN 1 ELSE 0 END), 0) AS approve,
              COALESCE(SUM(CASE WHEN option = 2 THEN 1 ELSE 0 END), 0) AS oppose,
              COALESCE(SUM(CASE WHEN option = 3 THEN 1 ELSE 0 END), 0) AS neutral
       FROM votes WHERE poll_id = ?`
    ).bind(pollId).first<{ approve: number; oppose: number; neutral: number }>();

    const previous = await env.DB.prepare(
      'SELECT hash FROM stats_snapshots WHERE poll_id = ? ORDER BY ts_hour DESC LIMIT 1'
    ).bind(pollId).first<{ hash: string }>();

    const snapshot = await makeSnapshot({
      pollId,
      tsHour,
      counts: {
        approve: Number(counts?.approve ?? 0),
        oppose: Number(counts?.oppose ?? 0),
        neutral: Number(counts?.neutral ?? 0)
      },
      prevHash: previous?.hash ?? null
    });

    await env.DB.prepare(
      `INSERT INTO stats_snapshots (poll_id, ts_hour, approve, oppose, neutral, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(poll_id, ts_hour) DO NOTHING`
    ).bind(
      snapshot.pollId, snapshot.tsHour, snapshot.approve, snapshot.oppose,
      snapshot.neutral, snapshot.prevHash, snapshot.hash
    ).run();
  }
}