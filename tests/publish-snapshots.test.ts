import { describe, expect, it } from 'vitest';
import { mergeSnapshots, resumeAfter, snapshotHour } from '../scripts/publish-snapshots.mjs';

// A stored chain whose newest row was written before the poll closed: the row is
// not final, so a later close rewrote that same hour with the terminal counts,
// hash, and `final: true`. The publish script must re-fetch that hour.
const storedChain = [
  { tsHourEpoch: 98, approve: 1, oppose: 0, neutral: 0, prevHash: 'GENESIS', hash: 'h98', final: false },
  { tsHourEpoch: 99, approve: 2, oppose: 0, neutral: 0, prevHash: 'h98', hash: 'h99', final: false },
  { tsHourEpoch: 100, approve: 2, oppose: 1, neutral: 0, prevHash: 'h99', hash: 'pre-close', final: false }
];

describe('snapshotHour', () => {
  it('reads the numeric hour and treats a missing value as zero', () => {
    expect(snapshotHour({ tsHourEpoch: 100 })).toBe(100);
    expect(snapshotHour({})).toBe(0);
    expect(snapshotHour(null)).toBe(0);
  });
});

describe('resumeAfter', () => {
  it('re-fetches the closing hour when the newest stored row is not final', () => {
    expect(resumeAfter(storedChain)).toBe(99);
  });

  it('keeps the newest hour when it is already final', () => {
    const finalChain = [...storedChain.slice(0, 2), { tsHourEpoch: 100, hash: 'final-hash', final: true }];
    expect(resumeAfter(finalChain)).toBe(100);
  });

  it('starts from the beginning when nothing is stored', () => {
    expect(resumeAfter([])).toBe(0);
  });
});

describe('mergeSnapshots', () => {
  it('replaces the refreshed non-final closing hour with the terminal row', () => {
    // The refreshed row the API returns for `after = 99` when the poll closed.
    const refreshed = [
      { tsHourEpoch: 100, approve: 3, oppose: 1, neutral: 0, prevHash: 'h99', hash: 'post-close', final: true }
    ];
    const merged = mergeSnapshots(storedChain, refreshed);

    // Replaced by hour, so the chain length does not grow.
    expect(merged).toHaveLength(storedChain.length);
    expect(merged.map((snapshot) => snapshotHour(snapshot))).toEqual([98, 99, 100]);
    expect(merged.at(-1)).toMatchObject({
      tsHourEpoch: 100,
      approve: 3,
      hash: 'post-close',
      final: true
    });
  });

  it('sorts merged snapshots by hour without duplicating', () => {
    const merged = mergeSnapshots(
      [{ tsHourEpoch: 2, hash: 'b' }],
      [{ tsHourEpoch: 1, hash: 'a' }, { tsHourEpoch: 2, hash: 'b2' }]
    );
    expect(merged.map((snapshot) => snapshotHour(snapshot))).toEqual([1, 2]);
    expect(merged.at(-1)?.hash).toBe('b2');
  });
});
describe('snapshot schema version', () => {
  it('merges a version 1 chain with the new fields without dropping it', () => {
    // A chain copied out before the poll types release has no ballots or option
    // counts. A later run must keep those rows and add the new ones.
    const legacy = [
      { tsHourEpoch: 100, approve: 1, oppose: 0, neutral: 0, prevHash: 'GENESIS', hash: 'v1', final: false }
    ];
    const added = [
      {
        tsHourEpoch: 101,
        approve: 2,
        oppose: 0,
        neutral: 0,
        ballots: 2,
        optionCounts: null,
        prevHash: 'v1',
        hash: 'v2',
        final: false
      }
    ];
    const merged = mergeSnapshots(legacy, added);
    expect(merged).toHaveLength(2);
    // The legacy row is untouched: no `ballots` field is invented for it.
    expect(merged[0]).not.toHaveProperty('ballots');
    expect(merged[1]).toMatchObject({ ballots: 2 });
  });
});
