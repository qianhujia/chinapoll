import { describe, expect, it } from 'vitest';
import { parseRateLimit } from '../worker/services/rateLimit';
import { ipBucket, hashedNetworkBucket, isValidServerKey } from '../worker/services/ip';
import { makeSnapshot, verifySnapshotHash } from '../worker/services/snapshot';
import { normalizeRecoveryCode } from '../worker/services/recovery';
import { checkAccountAge, validateUserPassword } from '../worker/services/users';
import { enforceSameOrigin } from '../worker/services/csrf';
import { validateProposal } from '../worker/api/proposal';
import { dayBucket, last7DayCutoff, publicViews, todayBucket } from '../worker/api/views';
import {
  getPollReportReasonCode,
  getPollReportReasonLabel,
  getReportResolutionCode,
  getReportResolutionLabel,
  isPriorityReportReason,
  PollReportReason,
  ReportResolution
} from '../worker/enums';

const KEY = '1f2e3d4c5b6a798807162534435261708f9e0d1c2b3a495867758493a2b1c0d1';

describe('enforceSameOrigin', () => {
  const mutate = (url: string, headers: Record<string, string> = {}) =>
    new Request(url, { method: 'POST', headers });

  it('allows a mutation whose Origin matches the request origin', () => {
    const request = mutate('http://127.0.0.1:8787/api/proposal', { origin: 'http://127.0.0.1:8787' });
    expect(enforceSameOrigin(request, { viaCookie: true })).toBeNull();
  });

  it('rejects a cross-origin mutation', () => {
    // The Vite dev proxy must keep the browser Host so this stays a same-origin
    // request; a rewritten Host reproduces the rejected 403 case below.
    const rewrittenHost = mutate('http://127.0.0.1:8787/api/proposal', { origin: 'http://localhost:5173' });
    const response = enforceSameOrigin(rewrittenHost, { viaCookie: true });
    expect(response?.status).toBe(403);

    const preservedHost = mutate('http://localhost:5173/api/proposal', { origin: 'http://localhost:5173' });
    expect(enforceSameOrigin(preservedHost, { viaCookie: true })).toBeNull();
  });

  it('rejects a mutation with no Origin header', () => {
    const response = enforceSameOrigin(mutate('http://127.0.0.1:8787/api/proposal'), { viaCookie: true });
    expect(response?.status).toBe(403);
  });

  it('allows a configured extra origin', () => {
    const request = mutate('http://127.0.0.1:8788/api/admin/settings', { origin: 'https://admin.chinapoll.org' });
    expect(enforceSameOrigin(request, { viaCookie: true, extraOrigin: 'https://admin.chinapoll.org' })).toBeNull();
  });

  it('skips the check for safe methods and header-authenticated requests', () => {
    const get = new Request('http://127.0.0.1:8787/api/proposal', { headers: { origin: 'http://evil.example' } });
    expect(enforceSameOrigin(get, { viaCookie: true })).toBeNull();

    const headerAuth = mutate('http://127.0.0.1:8787/api/proposal', { origin: 'http://evil.example' });
    expect(enforceSameOrigin(headerAuth, { viaCookie: false })).toBeNull();
  });
});

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
    expect(isValidServerKey('short')).toBe(false);
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
    const first = await makeSnapshot({ pollId: 1, tsHour: 100, counts: { approve: 3, oppose: 1, neutral: 0 }, views: 7, prevHash: null });
    expect(first.prevHash).toBe('GENESIS');
    expect(first.views).toBe(7);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    const recomputed = await verifySnapshotHash({
      pollId: first.pollId, tsHour: first.tsHour, approve: first.approve,
      oppose: first.oppose, neutral: first.neutral, views: first.views, prevHash: first.prevHash
    });
    expect(recomputed).toBe(first.hash);

    // The cumulative views are part of the hashed payload.
    const tampered = await verifySnapshotHash({
      pollId: first.pollId, tsHour: first.tsHour, approve: first.approve,
      oppose: first.oppose, neutral: first.neutral, views: first.views + 1, prevHash: first.prevHash
    });
    expect(tampered).not.toBe(first.hash);

    const second = await makeSnapshot({ pollId: 1, tsHour: 101, counts: { approve: 4, oppose: 1, neutral: 0 }, views: 9, prevHash: first.hash });
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

describe('validateProposal', () => {
  it('accepts a title with no description because the description is optional', () => {
    const result = validateProposal({ title: 'Public transit funding', mode: 'evergreen' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.description).toBeNull();
  });

  it('keeps a substantive description', () => {
    const description = 'A sufficiently long description of the proposal.';
    const result = validateProposal({ title: 'Public transit funding', mode: 'evergreen', description });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.description).toBe(description);
  });

  it('rejects a short non-empty description', () => {
    const result = validateProposal({ title: 'Public transit funding', mode: 'evergreen', description: 'too short' });
    expect(result.ok).toBe(false);
  });

  it('rejects a blank title', () => {
    expect(validateProposal({ title: '   ', mode: 'evergreen' }).ok).toBe(false);
  });

  it('rejects a deadline poll whose start is not in the future', () => {
    const now = Date.parse('2026-10-11T00:00:00Z');
    const result = validateProposal({
      title: 'Deadline poll',
      mode: 'deadline',
      startAt: '2026-10-10T00:00:00Z',
      endAt: '2026-10-12T00:00:00Z'
    }, now);
    expect(result.ok).toBe(false);
  });

  it('accepts a deadline poll with a valid future window', () => {
    const now = Date.parse('2026-10-11T00:00:00Z');
    const result = validateProposal({
      title: 'Deadline poll',
      mode: 'deadline',
      startAt: '2026-10-12T00:00:00Z',
      endAt: '2026-10-19T00:00:00Z'
    }, now);
    expect(result.ok).toBe(true);
  });
});

describe('poll report enums', () => {
  it('round-trips every reason label and code', () => {
    const labels = ['spam', 'inappropriate', 'misleading', 'copyright', 'personal_info', 'harassment', 'illegal', 'other'] as const;
    labels.forEach((label, index) => {
      const code = getPollReportReasonCode(label);
      expect(code).toBe(index + 1);
      expect(getPollReportReasonLabel(code!)).toBe(label);
    });
    expect(getPollReportReasonCode('nonsense')).toBeNull();
  });

  it('treats codes 5, 6, and 7 as high priority', () => {
    expect(isPriorityReportReason(PollReportReason.PersonalInfo)).toBe(true);
    expect(isPriorityReportReason(PollReportReason.Harassment)).toBe(true);
    expect(isPriorityReportReason(PollReportReason.Illegal)).toBe(true);
    expect(isPriorityReportReason(PollReportReason.Spam)).toBe(false);
    expect(isPriorityReportReason(PollReportReason.Other)).toBe(false);
  });

  it('maps resolution codes', () => {
    expect(getReportResolutionCode('dismissed')).toBe(ReportResolution.Dismissed);
    expect(getReportResolutionCode('action_taken')).toBe(ReportResolution.ActionTaken);
    expect(getReportResolutionCode('nope')).toBeNull();
    expect(getReportResolutionLabel(ReportResolution.ActionTaken)).toBe('action_taken');
  });
});

describe('view day buckets', () => {
  it('floors a timestamp to the UTC day', () => {
    expect(dayBucket(0)).toBe(0);
    expect(dayBucket(86_399)).toBe(0);
    expect(dayBucket(86_400)).toBe(86_400);
    expect(todayBucket(86_400 * 1000 * 3 + 5_000)).toBe(86_400 * 3);
  });

  it('starts the 7-day window six buckets before today', () => {
    expect(last7DayCutoff(86_400 * 1000 * 10)).toBe(86_400 * 4);
  });

  it('withholds view counts below the display threshold', () => {
    expect(publicViews({ total: 5, last7Days: 5 }, 20)).toBeNull();
    expect(publicViews({ total: 20, last7Days: 12 }, 20)).toEqual({ total: 20, last7Days: 12 });
    expect(publicViews(undefined, 0)).toBeNull();
    expect(publicViews({ total: 1, last7Days: 1 }, 0)).toEqual({ total: 1, last7Days: 1 });
  });
});
