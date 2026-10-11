// Public read-only access to the signed statistics snapshot chain.

import type { HandlerEnv } from '../index';
import { verifySnapshotHash, type SnapshotRecord } from '../services/snapshot';

interface SnapshotRow {
  poll_id: number;
  ts_hour: number;
  approve: number;
  oppose: number;
  neutral: number;
  prev_hash: string;
  hash: string;
}

const MAX_SNAPSHOTS = 500;

function toRecord(row: SnapshotRow): SnapshotRecord {
  return {
    pollId: Number(row.poll_id),
    tsHour: Number(row.ts_hour),
    approve: Number(row.approve),
    oppose: Number(row.oppose),
    neutral: Number(row.neutral),
    prevHash: row.prev_hash,
    hash: row.hash
  };
}

// Returns up to `limit` snapshots for a poll whose ts_hour is greater than the
// cursor, ordered ascending.
async function fetchPage(env: HandlerEnv, pollId: number, after: number, limit: number): Promise<SnapshotRow[]> {
  const result = await env.DB.prepare(
    `SELECT poll_id, ts_hour, approve, oppose, neutral, prev_hash, hash
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
        if (await verifySnapshotHash(record) !== record.hash) { valid = false; break; }
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
    snapshots: rows.map((row) => {
      const snapshot = toRecord(row);
      return {
        tsHour: new Date(snapshot.tsHour * 1000).toISOString(),
        tsHourEpoch: snapshot.tsHour,
        approve: snapshot.approve,
        oppose: snapshot.oppose,
        neutral: snapshot.neutral,
        prevHash: snapshot.prevHash,
        hash: snapshot.hash
      };
    }),
    nextAfter: last,
    hasMore: rows.length === MAX_SNAPSHOTS
  }, {
    headers: { 'cache-control': 'no-store' }
  });
}