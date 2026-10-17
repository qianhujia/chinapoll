// Signed hourly statistics snapshots.
//
// Each snapshot carries the counts for one poll at one hour and a hash that
// covers the canonical payload and the previous snapshot's hash, forming a chain
// that can be verified later by anyone who stores the published JSON.
//
// The canonical payload covers the number of ballots, the per-option counts, the
// cumulative view total, and the chain link, so rewriting any published count is
// detectable.
//
// Schema version:
//   * version 1 - the original payload: poll id, hour, the three verdict counts,
//     the cumulative views, and the chain link. Chains published before the poll
//     types release carry this shape.
//   * version 2 - adds `ballots` and `optionCounts` next to the three verdict
//     counts.
//   * version 3 - drops the three verdict counts, which are no longer a concept
//     now that a verdict poll is an ordinary single choice poll. `makeSnapshot`
//     always writes version 3; `verifySnapshotHash` and `matchesStoredHash` still
//     reproduce the version 1 and 2 payloads, so an older chain is never reported
//     as tampered with. The verdict counts needed to recompute those payloads stay
//     in `stats_snapshots`.

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
  /**
   * Verdict counts of a record signed before schema version 3. They are kept so
   * those payloads stay reproducible; a version 3 record reports 0.
   */
  approve?: number;
  oppose?: number;
  neutral?: number;
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

// A stored or published record as held by a verifier: the current fields plus the
// ones that only exist on a legacy record.
export type VerifiableSnapshotRecord = Omit<SnapshotRecord, 'ballots' | 'optionCounts' | 'hash'>
  & Partial<Pick<SnapshotRecord, 'ballots' | 'optionCounts' | 'hash'>>;

// The record on its way to being signed: everything the payload covers, without
// the hash that is being computed.
export type CanonicalRecord = Omit<VerifiableSnapshotRecord, 'hash'>;

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

// The version 1 payload: poll id, hour, the three verdict counts, the cumulative
// views, and the chain link. Hashing this payload reproduces a chain that was
// published before the poll types release.
function canonicalJsonV1(record: CanonicalRecord): string {
  return JSON.stringify({
    pollId: record.pollId,
    tsHour: record.tsHour,
    approve: Number(record.approve ?? 0),
    oppose: Number(record.oppose ?? 0),
    neutral: Number(record.neutral ?? 0),
    views: record.views,
    prevHash: record.prevHash
  });
}

// The version 2 payload: the version 1 payload plus the number of ballots and
// the per-option counts, with an explicit `schemaVersion`.
function canonicalJsonV2(record: CanonicalRecord): string {
  return JSON.stringify({
    schemaVersion: 2,
    pollId: record.pollId,
    tsHour: record.tsHour,
    approve: Number(record.approve ?? 0),
    oppose: Number(record.oppose ?? 0),
    neutral: Number(record.neutral ?? 0),
    ballots: Number(record.ballots ?? 0),
    optionCounts: normalizeOptionCounts(record.optionCounts),
    views: record.views,
    prevHash: record.prevHash
  });
}

// The current payload: the verdict counts are gone and only the ballots and the
// per-option counts describe the result.
function canonicalJsonV3(record: CanonicalRecord): string {
  return JSON.stringify({
    schemaVersion: 3,
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
  const hash = await sha256Hex(`${record.prevHash}:${canonicalJsonV3(record)}`);
  return { ...record, hash };
}

// Recomputes the hash of a stored snapshot so a verifier can confirm the chain.
//
// A record that carries `ballots` (or `optionCounts`) was written by version 2 or
// later and is hashed with the current payload. A record without them is a
// version 1 record and is hashed with the original payload, so a chain copied out
// earlier still verifies.
export async function verifySnapshotHash(record: VerifiableSnapshotRecord): Promise<string> {
  return hashSnapshot(record, record.ballots === undefined && record.optionCounts === undefined
    ? 1
    : SNAPSHOT_SCHEMA_VERSION);
}

// Hashes a record with an explicit schema version, so a caller holding only a
// stored hash can try each supported version and accept the record when either
// reproduces it.
export async function hashSnapshot(record: VerifiableSnapshotRecord, schemaVersion: number): Promise<string> {
  const payload = schemaVersion === 1
    ? canonicalJsonV1(record)
    : schemaVersion === 2
      ? canonicalJsonV2(record)
      : canonicalJsonV3(record);
  return sha256Hex(`${record.prevHash}:${payload}`);
}

// True when a stored record reproduces its own hash under any supported schema
// version. Used by the verify walk, which cannot tell a legacy row from a
// current one without recomputing.
export async function matchesStoredHash(record: SnapshotRecord): Promise<boolean> {
  for (const version of [SNAPSHOT_SCHEMA_VERSION, 2, 1]) {
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

