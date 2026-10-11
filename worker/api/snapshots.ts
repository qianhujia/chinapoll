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

  const result = await env.DB.prepare(
    `SELECT poll_id, ts_hour, approve, oppose, neutral, prev_hash, hash
     FROM stats_snapshots WHERE poll_id = ?
     ORDER BY ts_hour ASC LIMIT ?`
  ).bind(pollId, MAX_SNAPSHOTS).all<SnapshotRow>();

  const snapshots = (result.results ?? []).map(toRecord);

  if (match[2] === 'verify') {
    let valid = true;
    for (let index = 0; index < snapshots.length; index += 1) {
      const expectedPrev = index === 0 ? 'GENESIS' : snapshots[index - 1].hash;
      const recomputed = await verifySnapshotHash({
        pollId: snapshots[index].pollId,
        tsHour: snapshots[index].tsHour,
        approve: snapshots[index].approve,
        oppose: snapshots[index].oppose,
        neutral: snapshots[index].neutral,
        prevHash: snapshots[index].prevHash
      });
      if (snapshots[index].prevHash !== expectedPrev || recomputed !== snapshots[index].hash) {
        valid = false;
        break;
      }
    }
    return Response.json({ pollId, valid, count: snapshots.length }, {
      headers: { 'cache-control': 'no-store' }
    });
  }

  return Response.json({
    pollId,
    snapshots: snapshots.map((snapshot) => ({
      tsHour: new Date(snapshot.tsHour * 1000).toISOString(),
      approve: snapshot.approve,
      oppose: snapshot.oppose,
      neutral: snapshot.neutral,
      prevHash: snapshot.prevHash,
      hash: snapshot.hash
    }))
  }, {
    headers: { 'cache-control': 'no-store' }
  });
}