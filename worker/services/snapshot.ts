// Signed hourly statistics snapshots.
//
// Each snapshot carries the counts for one poll at one hour and a hash that
// covers the canonical payload and the previous snapshot's hash, forming a chain
// that can be verified later by anyone who stores the published JSON.
//
// The canonical payload covers the verdict counts, the number of ballots, the
// per-option counts of a choice poll, the cumulative view total, and the chain
// link, so rewriting any published count is detectable.
//
// Schema version:
//   * version 1 - the original payload: poll id, hour, the three verdict counts,
//     the cumulative views, and the chain link. Chains published before the poll
//     types release carry this shape.
//   * version 2 - adds `ballots` and `optionCounts`. `makeSnapshot` always
//     writes version 2; `verifySnapshotHash` accepts a record without the new
//     fields as version 1, so old chains still verify.

import { sha256Hex } from '../../shared/crypto';

export type VoteOption = 'approve' | 'oppose' | 'neutral';

export interface SnapshotOptionCount {
  position: number;
  count: number;
}

export interface SnapshotRecord {
  pollId: number;
  tsHour: number;
  approve: number;
  oppose: number;
  neutral: number;
  /** Number of ballots at that hour, for every poll type. */
  ballots: number;
  /** Per-option counts of a choice poll, or null for a verdict poll. */
  optionCounts: SnapshotOptionCount[] | null;
  views: number;
  prevHash: string;
  hash: string;
}

export interface SnapshotInput {
  pollId: number;
  tsHour: number;
  counts: Record<VoteOption, number>;
  ballots?: number;
  optionCounts?: SnapshotOptionCount[] | null;
  views: number;
  prevHash: string | null;
}

// The current canonical schema version.
export const SNAPSHOT_SCHEMA_VERSION = 2;

// A stored record that may predate the poll types release, so the new fields can
// be absent.
export type VerifiableSnapshotRecord = Omit<SnapshotRecord, 'hash' | 'ballots' | 'optionCounts'>
  & Partial<Pick<SnapshotRecord, 'ballots' | 'optionCounts'>>;

// Canonical JSON with a fixed key order so the hash is stable regardless of how
// the object was built.
function canonicalJson(input: Omit<SnapshotRecord, 'hash'>): string {
  return JSON.stringify({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    pollId: input.pollId,
    tsHour: input.tsHour,
    approve: input.approve,
    oppose: input.oppose,
    neutral: input.neutral,
    ballots: input.ballots,
    optionCounts: input.optionCounts,
    views: input.views,
    prevHash: input.prevHash
  });
}

// The version 1 payload, used only to recompute the hash of a chain that was
// published before the poll types release.
function canonicalJsonV1(input: VerifiableSnapshotRecord): string {
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


export async function makeSnapshot({
  pollId,
  tsHour,
  counts,
  ballots,
  optionCounts,
  views,
  prevHash
}: SnapshotInput): Promise<SnapshotRecord> {
  const record = {
    pollId,
    tsHour,
    approve: counts.approve ?? 0,
    oppose: counts.oppose ?? 0,
    neutral: counts.neutral ?? 0,
    ballots: ballots ?? (counts.approve ?? 0) + (counts.oppose ?? 0) + (counts.neutral ?? 0),
    optionCounts: normalizeOptionCounts(optionCounts),
    views: views ?? 0,
    prevHash: prevHash ?? 'GENESIS'
  };
  const hash = await sha256Hex(`${record.prevHash}:${canonicalJson(record)}`);
  return { ...record, hash };
}

// Recomputes the hash of a stored snapshot so a verifier can confirm the chain.
//
// A record that carries `ballots` (or `optionCounts`) is a version 2 record and
// is hashed with the current payload. A record without them is treated as a
// version 1 record - the shape published before the poll types release - and is
// hashed with the original payload, so a chain copied out earlier still
// verifies. Records written from now on always carry `ballots`, so the version 2
// branch is the normal path.
export async function verifySnapshotHash(record: VerifiableSnapshotRecord): Promise<string> {
  return hashSnapshot(record, record.ballots === undefined && record.optionCounts === undefined ? 1 : SNAPSHOT_SCHEMA_VERSION);
}

// Hashes a record with an explicit schema version, so a caller holding only a
// stored hash can try each supported version and accept the record when either
// reproduces it.
export async function hashSnapshot(record: VerifiableSnapshotRecord, schemaVersion: number): Promise<string> {
  if (schemaVersion === 1) return sha256Hex(`${record.prevHash}:${canonicalJsonV1(record)}`);
  return sha256Hex(`${record.prevHash}:${canonicalJson({
    pollId: record.pollId,
    tsHour: record.tsHour,
    approve: record.approve,
    oppose: record.oppose,
    neutral: record.neutral,
    ballots: Number(record.ballots ?? 0),
    optionCounts: normalizeOptionCounts(record.optionCounts),
    views: record.views,
    prevHash: record.prevHash
  })}`);
}

// True when a stored record reproduces its own hash under any supported schema
// version. Used by the verify walk, which cannot tell a legacy row from a
// current one without recomputing.
export async function matchesStoredHash(record: SnapshotRecord): Promise<boolean> {
  for (const version of [SNAPSHOT_SCHEMA_VERSION, 1]) {
    if (await hashSnapshot(record, version) === record.hash) return true;
  }
  return false;
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
