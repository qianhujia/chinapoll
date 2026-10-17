// Signed hourly statistics snapshots.
//
// Each snapshot carries the counts for one poll at one hour and a hash that
// covers the canonical payload and the previous snapshot's hash, forming a chain
// that can be verified later by anyone who stores the published JSON.

import { sha256Hex } from '../../shared/crypto';

export type VoteOption = 'approve' | 'oppose' | 'neutral';

export interface SnapshotRecord {
  pollId: number;
  tsHour: number;
  approve: number;
  oppose: number;
  neutral: number;
  views: number;
  prevHash: string;
  hash: string;
}

export interface SnapshotInput {
  pollId: number;
  tsHour: number;
  counts: Record<VoteOption, number>;
  views: number;
  prevHash: string | null;
}

// Canonical JSON with a fixed key order so the hash is stable regardless of how
// the object was built.
function canonicalJson(input: Omit<SnapshotRecord, 'hash'>): string {
  return JSON.stringify({
    pollId: input.pollId,
    tsHour: input.tsHour,
    approve: input.approve,
    oppose: input.oppose,
    neutral: input.neutral,
    views: input.views,
    prevHash: input.prevHash
  });
}

export async function makeSnapshot({ pollId, tsHour, counts, views, prevHash }: SnapshotInput): Promise<SnapshotRecord> {
  const record = {
    pollId,
    tsHour,
    approve: counts.approve ?? 0,
    oppose: counts.oppose ?? 0,
    neutral: counts.neutral ?? 0,
    views: views ?? 0,
    prevHash: prevHash ?? 'GENESIS'
  };
  const hash = await sha256Hex(`${record.prevHash}:${canonicalJson(record)}`);
  return { ...record, hash };
}

// Recomputes the hash of a stored snapshot so a verifier can confirm the chain.
export async function verifySnapshotHash(record: Omit<SnapshotRecord, 'hash'>): Promise<string> {
  return sha256Hex(`${record.prevHash}:${canonicalJson(record)}`);
}
