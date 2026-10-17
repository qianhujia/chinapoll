// Public read-only access to the signed statistics snapshot chain.

import type { HandlerEnv } from '../index';
import {
  SNAPSHOT_SCHEMA_VERSION,
  matchesStoredHash,
  parseOptionCounts,
  type SnapshotRecord
} from '../services/snapshot';

interface SnapshotRow {
  poll_id: number;
  ts_hour: number;
  approve: number;
  oppose: number;
  neutral: number;
  ballots: number;
  option_counts: string | null;
  views: number;
  prev_hash: string;
  hash: string;
  final: number;
}

const MAX_SNAPSHOTS = 500;

function toRecord(row: SnapshotRow): SnapshotRecord {
  return {
    pollId: Number(row.poll_id),
    tsHour: Number(row.ts_hour),
    // The three verdict columns only carry the counts of records signed before
    // schema version 3; they are 0 on a current record.
    approve: Number(row.approve),
    oppose: Number(row.oppose),
    neutral: Number(row.neutral),
    ballots: Number(row.ballots ?? 0),
    optionCounts: parseOptionCounts(row.option_counts),
    views: Number(row.views),
    prevHash: row.prev_hash,
    hash: row.hash
  };
}

// Returns up to `limit` snapshots for a poll whose ts_hour is greater than the
// cursor, ordered ascending.
async function fetchPage(env: HandlerEnv, pollId: number, after: number, limit: number): Promise<SnapshotRow[]> {
  const result = await env.DB.prepare(
    `SELECT poll_id, ts_hour, approve, oppose, neutral, ballots, option_counts,
            views, prev_hash, hash, final
     FROM stats_snapshots WHERE poll_id = ? AND ts_hour > ?
     ORDER BY ts_hour ASC LIMIT ?`
  ).bind(pollId, after, limit).all<SnapshotRow>();
  return result.results ?? [];
}

function parseCursor(url: URL): number | null {
  const raw = url.searchParams.get('after');
  if (raw === null) return 0;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

export async function handleSnapshotRequest(request: Request, url: URL, env: HandlerEnv): Promise<Response> {
  if (request.method !== 'GET') {
    return Response.json({ message: 'method not allowed' }, { status: 405 });
  }

  const match = url.pathname.match(/^\/api\/snapshots\/([1-9]\d*)(?:\/(verify))?$/);
  if (!match) {
    return Response.json({ message: 'not found' }, { status: 404 });
  }

  const pollId = Number(match[1]);
  if (!Number.isSafeInteger(pollId)) {
    return Response.json({ message: 'invalid poll ID' }, { status: 400 });
  }

  if (match[2] === 'verify') {
    // Walk the whole chain in pages so a long-running poll stays verifiable.
    let cursor = 0;
    let prevHash = 'GENESIS';
    let total = 0;
    let valid = true;
    for (;;) {
      const rows = await fetchPage(env, pollId, cursor, MAX_SNAPSHOTS);
      if (rows.length === 0) break;
      for (const row of rows) {
        const record = toRecord(row);
        if (record.prevHash !== prevHash) { valid = false; break; }
        // A record may be a version 2 row or one published before the new
        // fields existed, so either payload is accepted when it reproduces the
        // stored hash.
        if (!await matchesStoredHash(record)) { valid = false; break; }
        prevHash = record.hash;
        total += 1;
      }
      cursor = Number(rows[rows.length - 1].ts_hour);
      if (!valid || rows.length < MAX_SNAPSHOTS) break;
    }
    return Response.json({ pollId, valid, count: total }, {
      headers: { 'cache-control': 'no-store' }
    });
  }

  const after = parseCursor(url);
  if (after === null) {
    return Response.json({ message: 'invalid after cursor' }, { status: 400 });
  }

  const rows = await fetchPage(env, pollId, after, MAX_SNAPSHOTS);
  const last = rows.length > 0 ? Number(rows[rows.length - 1].ts_hour) : after;

  return Response.json({
    pollId,
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshots: rows.map((row) => {
      const snapshot = toRecord(row);
      return {
        tsHour: new Date(snapshot.tsHour * 1000).toISOString(),
        tsHourEpoch: snapshot.tsHour,
        // Reported so a verifier can recompute the payload of a record signed
        // before schema version 3; they are 0 on a current record.
        approve: snapshot.approve,
        oppose: snapshot.oppose,
        neutral: snapshot.neutral,
        // `ballots` is the number of ballots at that hour and `optionCounts`
        // carries the per-option counts of the poll.
        ballots: snapshot.ballots,
        optionCounts: snapshot.optionCounts,
        views: snapshot.views,
        prevHash: snapshot.prevHash,
        hash: snapshot.hash,
        // `final` marks the terminal snapshot written when the poll closed. It
        // is reported for verifiers and the publish script; the hash above
        // covers the ballots, the option counts, the cumulative views, and the
        // chain link.
        final: Number(row.final) === 1
      };
    }),
    nextAfter: last,
    hasMore: rows.length === MAX_SNAPSHOTS
  }, {
    headers: { 'cache-control': 'no-store' }
  });
}