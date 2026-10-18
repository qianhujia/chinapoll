import { describe, expect, it } from 'vitest';
import { mergeSnapshots, resumeAfter, snapshotHour } from '../worker/services/publisher';

// A stored chain whose newest row was written before the poll closed: the row is
// not final, so a later close rewrote that same hour with the terminal counts,
// hash, and `final: true`. The publisher must re-fetch that hour.
const storedChain = [
  { tsHourEpoch: 98, ballots: 1, prevHash: 'GENESIS', hash: 'h98', final: false },
  { tsHourEpoch: 99, ballots: 2, prevHash: 'h98', hash: 'h99', final: false },
  { tsHourEpoch: 100, ballots: 3, prevHash: 'h99', hash: 'pre-close', final: false }
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
    // The refreshed row the publisher reads when the poll has closed.
    const refreshed = [
      { tsHourEpoch: 100, ballots: 4, prevHash: 'h99', hash: 'post-close', final: true }
    ];
    const merged = mergeSnapshots(storedChain, refreshed);

    // Replaced by hour, so the chain length does not grow.
    expect(merged).toHaveLength(storedChain.length);
    expect(merged.map((snapshot) => snapshotHour(snapshot))).toEqual([98, 99, 100]);
    expect(merged.at(-1)).toMatchObject({
      tsHourEpoch: 100,
      ballots: 4,
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
