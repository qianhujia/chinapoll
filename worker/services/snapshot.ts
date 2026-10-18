// Signed hourly statistics snapshots.
//
// Each snapshot carries the counts for one poll at one hour and a hash that
// covers the canonical payload and the previous snapshot's hash, forming a chain
// that can be verified later by anyone who stores the published JSON.
//
// There is a single canonical format, `schemaVersion: 3`. It covers the number of
// ballots, the per-option counts, the cumulative view total, and the chain link,
// so rewriting any published count is detectable. The older version 1 and version
// 2 payloads are gone along with the legacy verdict columns they signed.

import { sha256Hex } from '../../shared/crypto';

export interface SnapshotOptionCount {
  position: number;
  count: number;
}

export interface SnapshotRecord {
  pollId: number;
  tsHour: number;
  /** Number of ballots at that hour, for every poll type. */
  ballots: number;
  /** Per-option counts of the poll, or null when the poll has no options. */
  optionCounts: SnapshotOptionCount[] | null;
  views: number;
  prevHash: string;
  hash: string;
}

export interface SnapshotInput {
  pollId: number;
  tsHour: number;
  ballots?: number;
  optionCounts?: SnapshotOptionCount[] | null;
  views: number;
  prevHash: string | null;
}

// The current canonical schema version.
export const SNAPSHOT_SCHEMA_VERSION = 3;

// The record on its way to being signed or verified: everything the payload
// covers, without the hash that is being computed.
export type CanonicalRecord = Omit<SnapshotRecord, 'hash'>;

// Normalizes the option counts so the hash never depends on the caller's
// ordering or number types.
function normalizeOptionCounts(
  optionCounts: SnapshotOptionCount[] | null | undefined
): SnapshotOptionCount[] | null {
  if (!optionCounts || optionCounts.length === 0) return null;
  return optionCounts
    .map((entry) => ({ position: Number(entry.position), count: Number(entry.count) }))
    .sort((left, right) => left.position - right.position);
}

// The canonical payload: poll id, hour, the number of ballots, the per-option
// counts, the cumulative view total, and the chain link.
function canonicalJson(record: CanonicalRecord): string {
  return JSON.stringify({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    pollId: record.pollId,
    tsHour: record.tsHour,
    ballots: Number(record.ballots ?? 0),
    optionCounts: normalizeOptionCounts(record.optionCounts),
    views: record.views,
    prevHash: record.prevHash
  });
}

// Builds and signs a snapshot with the current payload.
export async function makeSnapshot({
  pollId,
  tsHour,
  ballots,
  optionCounts,
  views,
  prevHash
}: SnapshotInput): Promise<SnapshotRecord> {
  const record = {
    pollId,
    tsHour,
    ballots: Number(ballots ?? 0),
    optionCounts: normalizeOptionCounts(optionCounts),
    views: views ?? 0,
    prevHash: prevHash ?? 'GENESIS'
  };
  const hash = await sha256Hex(`${record.prevHash}:${canonicalJson(record)}`);
  return { ...record, hash };
}

// Recomputes the hash of a stored snapshot so a verifier can confirm the chain.
export async function verifySnapshotHash(record: CanonicalRecord): Promise<string> {
  return sha256Hex(`${record.prevHash}:${canonicalJson(record)}`);
}

// Parses the JSON stored in `stats_snapshots.option_counts`.
export function parseOptionCounts(value: string | null): SnapshotOptionCount[] | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    const entries: SnapshotOptionCount[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) return null;
      const position = Number((entry as Record<string, unknown>).position);
      const count = Number((entry as Record<string, unknown>).count);
      if (!Number.isSafeInteger(position) || !Number.isSafeInteger(count)) return null;
      entries.push({ position, count });
    }
    return entries.sort((left, right) => left.position - right.position);
  } catch {
    return null;
  }
}

export function serializeOptionCounts(optionCounts: SnapshotOptionCount[] | null): string | null {
  const normalized = normalizeOptionCounts(optionCounts);
  return normalized === null ? null : JSON.stringify(normalized);
}

