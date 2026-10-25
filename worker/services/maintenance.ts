// Hourly maintenance tasks run by the public Worker's scheduled handler.
//
// Responsibilities:
//   * write a signed snapshot for every open poll and a terminal snapshot when a
//     poll closes (the hash chain in worker/services/snapshot.ts makes published
//     counts tamper-evident), so the chain always ends on the final result;
//   * publish the signed chain to the public audit repository when publishing is
//     enabled (worker/services/publisher.ts);
//   * advance the poll lifecycle (open, close, archive);
//   * purge vote rows thirty days after a poll closed and drop expired sessions
//     and stale account-cap rows.
//
// Retention is keyed on `polls.closed_at`, not `updated_at`, so editing a closed
// poll does not restart its retention clock.
//
// Counting goes through the shared engine in worker/services/options.ts, so a
// single choice poll and a multiple choice poll are tallied the same way.

import { PollMode, PollStatus, PollType } from '../enums';
import { countBallots, getOptionsForPolls, type PollOption } from './options';
import { runPublisher } from './publisher';
import { chunk } from '../../shared/db';
import { makeSnapshot, serializeOptionCounts, type SnapshotOptionCount } from './snapshot';

interface MaintenanceEnv {
  DB: D1Database;
}

const RETENTION_SECONDS = 30 * 24 * 60 * 60;
const ATTEMPT_RETENTION_SECONDS = 30 * 24 * 60 * 60;
// Resolved reports are deleted 90 days after `resolved_at`. Reports are removed
// with the poll by the foreign key cascade.
const REPORT_RETENTION_SECONDS = 90 * 24 * 60 * 60;
// View rows older than 90 days are rolled up into one row per poll (ts_day = 0)
// so long-term totals survive while daily resolution is dropped.
const VIEW_ROLLUP_SECONDS = 90 * 24 * 60 * 60;
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
const SNAPSHOT_POLLS_SQL = `SELECT id, status, poll_type FROM polls
   WHERE status = ?
      OR (status = ? AND closed_at IS NOT NULL AND closed_at >= ?
          AND NOT EXISTS (SELECT 1 FROM stats_snapshots s
                          WHERE s.poll_id = polls.id AND s.final = 1))`;

// Inserts a snapshot, or refreshes the row for the same poll and hour. The
// upsert keeps the terminal marker and the counts correct when an open snapshot
// written earlier in the same hour is followed by a close.
const INSERT_SNAPSHOT_SQL = `INSERT INTO stats_snapshots
   (poll_id, ts_hour, ballots, option_counts, views, prev_hash, hash, final)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(poll_id, ts_hour) DO UPDATE SET
     ballots = excluded.ballots,
     option_counts = excluded.option_counts,
     views = excluded.views,
     prev_hash = excluded.prev_hash,
     hash = excluded.hash,
     final = excluded.final`;

// Per-option counts of a poll, keyed by poll id and ordered by position.
type OptionCountMap = Map<number, SnapshotOptionCount[]>;

// Reads the counts of a set of polls through the shared engine, then shapes them
// for the snapshot: the number of ballots and the per-position counts of the
// poll's options.
async function loadSnapshotCounts(
  env: MaintenanceEnv,
  polls: Array<{ id: number; poll_type: number }>
): Promise<{
  ballots: Map<number, number>;
  optionCounts: OptionCountMap;
}> {
  const ballots = new Map<number, number>();
  const optionCounts: OptionCountMap = new Map();
  if (polls.length === 0) return { ballots, optionCounts };

  const tallies = await countBallots(env, polls);
  const optionsByPoll = await getOptionsForPolls(env, polls);

  for (const poll of polls) {
    const pollId = Number(poll.id);
    const tally = tallies.get(pollId) ?? { ballots: 0, counts: new Map<number, number>() };
    const options = optionsByPoll.get(pollId) ?? [];
    ballots.set(pollId, tally.ballots);
    optionCounts.set(pollId, perPositionCounts(options, tally.counts));
  }

  return { ballots, optionCounts };
}

// Reduces a poll's per-option tally to the per-position counts the snapshot
// stores, ordered by position. Selections always belong to the poll, so every
// counted option is present in the option list.
function perPositionCounts(options: PollOption[], tally: Map<number, number>): SnapshotOptionCount[] {
  return options
    .map((option) => ({ position: option.position, count: Number(tally.get(option.id) ?? 0) }))
    .sort((left, right) => left.position - right.position);
}


export async function runMaintenanceTasks(env: MaintenanceEnv): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const tsHour = now - (now % 3600);
  const cutoff = now - RETENTION_SECONDS;

  // New polls have no start time: a poll is opened either by an admin or by
  // auto-approval, and its end date is computed from `duration_seconds` at that
  // moment. The close step below acts on `end_at`.
  //
  // Stamp the end date of every open deadline poll that does not have one yet,
  // so a poll approved before this change or opened without a duration still
  // closes on schedule.
  await env.DB.prepare(
    `UPDATE polls SET end_at = unixepoch() + duration_seconds, updated_at = unixepoch()
     WHERE status = ? AND mode = ? AND duration_seconds IS NOT NULL AND end_at IS NULL`
  ).bind(PollStatus.Open, PollMode.Deadline).run();

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
    env.DB.prepare('DELETE FROM auth_attempts WHERE created_at < ?').bind(now - ATTEMPT_RETENTION_SECONDS),
    // Resolved reports are removed 90 days after they were resolved.
    env.DB.prepare(
      'DELETE FROM poll_reports WHERE resolved_at IS NOT NULL AND resolved_at <= ?'
    ).bind(now - REPORT_RETENTION_SECONDS)
  ]);

  // Roll up view rows older than 90 days into a single row per poll so daily
  // resolution is dropped while the long-term total survives, then drop the
  // individual daily rows. The insert must run before the delete.
  const viewCutoff = Math.floor((now - VIEW_ROLLUP_SECONDS) / 86400) * 86400;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO poll_views (poll_id, ts_day, views)
       SELECT poll_id, 0, SUM(views) FROM poll_views WHERE ts_day > 0 AND ts_day < ?
       GROUP BY poll_id
       ON CONFLICT(poll_id, ts_day) DO UPDATE SET views = views + excluded.views`
    ).bind(viewCutoff),
    env.DB.prepare('DELETE FROM poll_views WHERE ts_day > 0 AND ts_day < ?').bind(viewCutoff)
  ]);

  // Publish the signed chain after every snapshot this run has been written, so
  // a poll that closed this hour is copied out with its final counts. The
  // publisher catches its own errors and records them in `publish_runs`, so a
  // publish failure never stops the other maintenance tasks.
  await runPublisher(env, now);
}

// Writes one snapshot per poll that needs one in three queries total (poll ids,
// counts, previous hashes) plus a single batch insert, instead of three queries
// per poll.
async function writeSnapshots(env: MaintenanceEnv, tsHour: number, now: number): Promise<void> {
  const polls = await env.DB.prepare(SNAPSHOT_POLLS_SQL)
    .bind(PollStatus.Open, PollStatus.Closed, now - FINAL_SNAPSHOT_WINDOW_SECONDS)
    .all<{ id: number; status: number; poll_type: number }>();
  const entries = (polls.results ?? []).map((row) => ({
    id: Number(row.id),
    status: Number(row.status),
    pollType: Number(row.poll_type ?? PollType.SingleChoice),
    final: Number(row.status) === PollStatus.Closed
  }));
  if (entries.length === 0) return;

  const pollIds = entries.map((entry) => entry.id);

  // Every type is counted through the shared engine; the helper shapes the
  // result for the snapshot columns.
  const { ballots, optionCounts } = await loadSnapshotCounts(
    env,
    entries.map((entry) => ({ id: entry.id, poll_type: entry.pollType }))
  );

  // The two id lists are bound in batches: a D1 statement takes at most 100
  // parameters, and every open poll is snapshotted in this pass.
  const previous = new Map<number, string>();
  const viewsByPoll = new Map<number, number>();
  for (const batch of chunk(pollIds)) {
    const placeholders = batch.map(() => '?').join(', ');

    const hashRows = await env.DB.prepare(
      `SELECT s.poll_id, s.hash
       FROM stats_snapshots s
       JOIN (SELECT poll_id, MAX(ts_hour) AS ts_hour FROM stats_snapshots
             WHERE poll_id IN (${placeholders}) AND ts_hour < ?
             GROUP BY poll_id) latest
         ON latest.poll_id = s.poll_id AND latest.ts_hour = s.ts_hour`
    ).bind(...batch, tsHour).all<{ poll_id: number; hash: string }>();
    for (const row of hashRows.results ?? []) {
      previous.set(Number(row.poll_id), row.hash);
    }

    // Cumulative views per poll, carried into the signed snapshot.
    const viewsRows = await env.DB.prepare(
      `SELECT poll_id, COALESCE(SUM(views), 0) AS views FROM poll_views
       WHERE poll_id IN (${placeholders}) GROUP BY poll_id`
    ).bind(...batch).all<{ poll_id: number; views: number }>();
    for (const row of viewsRows.results ?? []) {
      viewsByPoll.set(Number(row.poll_id), Number(row.views));
    }
  }

  const insert = env.DB.prepare(INSERT_SNAPSHOT_SQL);

  const statements: D1PreparedStatement[] = [];
  for (const entry of entries) {
    const snapshot = await makeSnapshot({
      pollId: entry.id,
      tsHour,
      ballots: ballots.get(entry.id) ?? 0,
      optionCounts: optionCounts.get(entry.id) ?? null,
      views: viewsByPoll.get(entry.id) ?? 0,
      prevHash: previous.get(entry.id) ?? null
    });
    statements.push(insert.bind(
      snapshot.pollId, snapshot.tsHour, snapshot.ballots,
      serializeOptionCounts(snapshot.optionCounts), snapshot.views,
      snapshot.prevHash, snapshot.hash, entry.final ? 1 : 0
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
  const pollRow = await env.DB.prepare('SELECT id, poll_type FROM polls WHERE id = ?')
    .bind(pollId).first<{ id: number; poll_type: number }>();
  const pollType = Number(pollRow?.poll_type ?? PollType.SingleChoice);
  const { ballots, optionCounts } = await loadSnapshotCounts(env, [{ id: pollId, poll_type: pollType }]);

  const previous = await env.DB.prepare(
    `SELECT hash FROM stats_snapshots
     WHERE poll_id = ? AND ts_hour < ? ORDER BY ts_hour DESC LIMIT 1`
  ).bind(pollId, tsHour).first<{ hash: string }>();

  const viewsRow = await env.DB.prepare(
    'SELECT COALESCE(SUM(views), 0) AS views FROM poll_views WHERE poll_id = ?'
  ).bind(pollId).first<{ views: number }>();

  const snapshot = await makeSnapshot({
    pollId,
    tsHour,
    ballots: ballots.get(pollId) ?? 0,
    optionCounts: optionCounts.get(pollId) ?? null,
    views: Number(viewsRow?.views ?? 0),
    prevHash: previous?.hash ?? null
  });

  await env.DB.prepare(INSERT_SNAPSHOT_SQL).bind(
    snapshot.pollId, snapshot.tsHour, snapshot.ballots,
    serializeOptionCounts(snapshot.optionCounts), snapshot.views,
    snapshot.prevHash, snapshot.hash, isFinal ? 1 : 0
  ).run();
}