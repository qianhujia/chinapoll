import { describe, expect, it } from 'vitest';
import { parseRateLimit } from '../worker/services/rateLimit';
import { ipBucket, hashedNetworkBucket, isValidIpHashKey } from '../worker/services/ip';
import { makeSnapshot, verifySnapshotHash } from '../worker/services/snapshot';
import { normalizeRecoveryCode } from '../worker/services/recovery';
import { checkAccountAge, validateUserPassword } from '../worker/services/users';

const KEY = '1f2e3d4c5b6a798807162534435261708f9e0d1c2b3a495867758493a2b1c0d1';

describe('parseRateLimit', () => {
  it('parses count and unit', () => {
    expect(parseRateLimit('5/h', '1/h')).toEqual({ count: 5, windowMs: 3_600_000 });
    expect(parseRateLimit('1/d', '1/h')).toEqual({ count: 1, windowMs: 86_400_000 });
  });

  it('falls back when the value is missing or malformed', () => {
    expect(parseRateLimit('', '3/h')).toEqual({ count: 3, windowMs: 3_600_000 });
    expect(parseRateLimit('nonsense', '2/d')).toEqual({ count: 2, windowMs: 86_400_000 });
  });
});

describe('ipBucket', () => {
  it('reduces IPv4 to its /24 network', () => {
    expect(ipBucket('203.0.113.10')).toBe(ipBucket('203.0.113.200'));
    expect(ipBucket('203.0.113.10')).not.toBe(ipBucket('203.0.114.10'));
  });

  it('is stable for IPv6 input', () => {
    expect(ipBucket('2001:db8::1')).toBe(ipBucket('2001:db8::1'));
  });
});

describe('hashedNetworkBucket', () => {
  it('rejects a malformed key', async () => {
    expect(isValidIpHashKey('short')).toBe(false);
    expect(await hashedNetworkBucket('203.0.113.10', 'short')).toBeNull();
  });

  it('produces a keyed, day-rotated hex value', async () => {
    const day1 = await hashedNetworkBucket('203.0.113.10', KEY, new Date('2026-01-01T00:00:00Z'));
    const day1again = await hashedNetworkBucket('203.0.113.10', KEY, new Date('2026-01-01T23:00:00Z'));
    const day2 = await hashedNetworkBucket('203.0.113.10', KEY, new Date('2026-01-02T00:00:00Z'));
    expect(day1).toMatch(/^[0-9a-f]{64}$/);
    expect(day1).toBe(day1again);
    expect(day1).not.toBe(day2);
  });

  it('rotates the month period per calendar month', async () => {
    const january = await hashedNetworkBucket('203.0.113.10', KEY, new Date('2026-01-01T00:00:00Z'), 'month');
    const januaryLater = await hashedNetworkBucket('203.0.113.10', KEY, new Date('2026-01-28T00:00:00Z'), 'month');
    const february = await hashedNetworkBucket('203.0.113.10', KEY, new Date('2026-02-01T00:00:00Z'), 'month');
    const daily = await hashedNetworkBucket('203.0.113.10', KEY, new Date('2026-01-01T00:00:00Z'), 'day');
    expect(january).toBe(januaryLater);
    expect(january).not.toBe(february);
    expect(january).not.toBe(daily);
  });
});

describe('makeSnapshot', () => {
  it('chains the previous hash and is deterministic', async () => {
    const first = await makeSnapshot({ pollId: 1, tsHour: 100, counts: { approve: 3, oppose: 1, neutral: 0 }, prevHash: null });
    expect(first.prevHash).toBe('GENESIS');
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    const recomputed = await verifySnapshotHash({
      pollId: first.pollId, tsHour: first.tsHour, approve: first.approve,
      oppose: first.oppose, neutral: first.neutral, prevHash: first.prevHash
    });
    expect(recomputed).toBe(first.hash);

    const second = await makeSnapshot({ pollId: 1, tsHour: 101, counts: { approve: 4, oppose: 1, neutral: 0 }, prevHash: first.hash });
    expect(second.prevHash).toBe(first.hash);
    expect(second.hash).not.toBe(first.hash);
  });
});

describe('normalizeRecoveryCode', () => {
  it('uppercases, strips separators, and folds lookalikes', () => {
    expect(normalizeRecoveryCode('abcd-efgh')).toBe('ABCDEFGH');
    expect(normalizeRecoveryCode('i l o')).toBe('110');
  });
});

describe('validateUserPassword', () => {
  it('enforces the minimum length', () => {
    expect(validateUserPassword('short').ok).toBe(false);
    expect(validateUserPassword('a'.repeat(12)).ok).toBe(true);
  });

  it('rejects a password equal to the username', () => {
    expect(validateUserPassword('abcdefghijkl', 'abcdefghijkl').ok).toBe(false);
  });
});

describe('checkAccountAge', () => {
  it('allows an old enough account', () => {
    const now = 1_000_000;
    expect(checkAccountAge(now - 48 * 3600, 48, now).allowed).toBe(true);
  });

  it('reports the remaining hours for a new account', () => {
    const now = 1_000_000;
    const result = checkAccountAge(now, 24, now);
    expect(result.allowed).toBe(false);
    expect(result.remainingHours).toBe(24);
  });
});