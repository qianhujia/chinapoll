import { describe, expect, it } from 'vitest';
import { parseRateLimit } from '../worker/services/rateLimit';
import { ipBucket, hashedNetworkBucket, isValidServerKey } from '../worker/services/ip';
import { makeSnapshot, verifySnapshotHash } from '../worker/services/snapshot';
import { normalizeRecoveryCode } from '../worker/services/recovery';
import { checkAccountAge, validateUserPassword } from '../worker/services/users';
import { enforceSameOrigin } from '../worker/services/csrf';
import { validateProposal } from '../worker/api/proposal';
import { choiceCounts, validatePollOptions } from '../worker/services/pollType';
import { dayBucket, last7DayCutoff, publicViews, todayBucket } from '../worker/api/views';
import {
  durationMode,
  durationSeconds,
  getPollReportReasonCode,
  getPollReportReasonLabel,
  getPollTypeCode,
  getPollTypeLabel,
  getReportResolutionCode,
  getReportResolutionLabel,
  isPollDuration,
  isPriorityReportReason,
  POLL_DURATIONS,
  PollMode,
  PollReportReason,
  PollType,
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
    // A verdict poll carries the ballot total as well, so the chain covers it.
    expect(first.ballots).toBe(4);
    expect(first.optionCounts).toBeNull();
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    const recomputed = await verifySnapshotHash({
      pollId: first.pollId, tsHour: first.tsHour, approve: first.approve,
      oppose: first.oppose, neutral: first.neutral, ballots: first.ballots,
      optionCounts: first.optionCounts, views: first.views, prevHash: first.prevHash
    });
    expect(recomputed).toBe(first.hash);

    // The cumulative views are part of the hashed payload.
    const tampered = await verifySnapshotHash({
      pollId: first.pollId, tsHour: first.tsHour, approve: first.approve,
      oppose: first.oppose, neutral: first.neutral, ballots: first.ballots,
      optionCounts: first.optionCounts, views: first.views + 1, prevHash: first.prevHash
    });
    expect(tampered).not.toBe(first.hash);

    // So are the number of ballots and the per-option counts.
    const tamperedBallots = await verifySnapshotHash({
      pollId: first.pollId, tsHour: first.tsHour, approve: first.approve,
      oppose: first.oppose, neutral: first.neutral, ballots: first.ballots + 1,
      optionCounts: first.optionCounts, views: first.views, prevHash: first.prevHash
    });
    expect(tamperedBallots).not.toBe(first.hash);

    const choice = await makeSnapshot({
      pollId: 2,
      tsHour: 100,
      counts: { approve: 0, oppose: 0, neutral: 0 },
      ballots: 4,
      optionCounts: [{ position: 1, count: 3 }, { position: 2, count: 1 }],
      views: 0,
      prevHash: null
    });
    expect(choice.optionCounts).toEqual([{ position: 1, count: 3 }, { position: 2, count: 1 }]);
    // The option counts are normalized, so the stored order does not change the hash.
    const reordered = await makeSnapshot({
      pollId: 2,
      tsHour: 100,
      counts: { approve: 0, oppose: 0, neutral: 0 },
      ballots: 4,
      optionCounts: [{ position: 2, count: 1 }, { position: 1, count: 3 }],
      views: 0,
      prevHash: null
    });
    expect(reordered.hash).toBe(choice.hash);
    const tamperedOptions = await verifySnapshotHash({
      pollId: 2, tsHour: 100, approve: 0, oppose: 0, neutral: 0, ballots: 4,
      optionCounts: [{ position: 1, count: 4 }, { position: 2, count: 1 }],
      views: 0, prevHash: 'GENESIS'
    });
    expect(tamperedOptions).not.toBe(choice.hash);

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
  const options = [
    { position: 1, label: 'Option one' },
    { position: 2, label: 'Option two' }
  ];

  it('accepts a title with no description because the description is optional', () => {
    const result = validateProposal({ title: 'Public transit funding', pollType: 'verdict', duration: 'none' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.description).toBeNull();
      expect(result.input.pollType).toBe(PollType.Verdict);
      expect(result.input.duration).toBe('none');
      expect(result.input.options).toEqual([]);
    }
  });

  it('keeps a substantive description', () => {
    const description = 'A sufficiently long description of the proposal.';
    const result = validateProposal({ title: 'Public transit funding', pollType: 'verdict', duration: '7d', description });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.description).toBe(description);
  });

  it('rejects a short non-empty description', () => {
    const result = validateProposal({
      title: 'Public transit funding', pollType: 'verdict', duration: 'none', description: 'too short'
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a blank title', () => {
    expect(validateProposal({ title: '   ', pollType: 'verdict', duration: 'none' }).ok).toBe(false);
  });

  it('requires a duration that is one of the seven labels', () => {
    expect(validateProposal({ title: 'No duration', pollType: 'verdict' }).ok).toBe(false);
    expect(validateProposal({ title: 'Bad duration', pollType: 'verdict', duration: '2w' }).ok).toBe(false);
    for (const duration of POLL_DURATIONS) {
      expect(validateProposal({ title: `Duration ${duration}`, pollType: 'verdict', duration }).ok).toBe(true);
    }
  });

  it('requires a valid poll type', () => {
    expect(validateProposal({ title: 'No type', duration: 'none' }).ok).toBe(false);
    expect(validateProposal({ title: 'Bad type', pollType: 'ranked', duration: 'none' }).ok).toBe(false);
  });

  it('accepts a single choice poll with 2 to 7 options', () => {
    const result = validateProposal({
      title: 'Preferred transit mode', pollType: 'single_choice', duration: '14d', options
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.pollType).toBe(PollType.SingleChoice);
      expect(result.input.options).toEqual(options);
    }
  });

  it('rejects too few, too many, duplicate, and over-long options', () => {
    const base = { title: 'Choice poll', pollType: 'multi_choice', duration: '1d' };
    expect(validateProposal({ ...base, options: [options[0]] }).ok).toBe(false);
    expect(validateProposal({
      ...base,
      options: Array.from({ length: 8 }, (_, index) => ({ position: index + 1, label: `Option ${index}` }))
    }).ok).toBe(false);
    expect(validateProposal({
      ...base,
      options: [{ position: 1, label: 'Same' }, { position: 2, label: 'same' }]
    }).ok).toBe(false);
    expect(validateProposal({
      ...base,
      options: [{ position: 1, label: 'x'.repeat(81) }, { position: 2, label: 'Other' }]
    }).ok).toBe(false);
    expect(validateProposal({
      ...base,
      options: [{ position: 1, label: '   ' }, { position: 2, label: 'Other' }]
    }).ok).toBe(false);
    expect(validateProposal({
      ...base,
      options: [{ position: 1, label: 'A' }, { position: 1, label: 'B' }]
    }).ok).toBe(false);
  });

  it('trims option labels', () => {
    const result = validateProposal({
      title: 'Choice poll', pollType: 'single_choice', duration: 'none',
      options: [{ position: 1, label: '  First  ' }, { position: 2, label: 'Second ' }]
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.options[0].label).toBe('First');
  });

  it('rejects options on a verdict poll', () => {
    const result = validateProposal({
      title: 'Verdict poll', pollType: 'verdict', duration: 'none', options
    });
    expect(result.ok).toBe(false);
  });
});

describe('poll type enums', () => {
  it('round-trips every type label and code', () => {
    const labels = ['verdict', 'single_choice', 'multi_choice'] as const;
    labels.forEach((label, index) => {
      const code = getPollTypeCode(label);
      expect(code).toBe(index + 1);
      expect(getPollTypeLabel(code!)).toBe(label);
    });
    expect(getPollTypeCode('nonsense')).toBeNull();
  });

  it('maps the duration labels to days, seconds, and a poll mode', () => {
    expect(POLL_DURATIONS).toEqual(['none', '1d', '3d', '7d', '14d', '1m', '1y']);
    expect(durationSeconds('none')).toBeNull();
    expect(durationSeconds('1d')).toBe(86_400);
    expect(durationSeconds('1m')).toBe(30 * 86_400);
    expect(durationSeconds('1y')).toBe(365 * 86_400);
    expect(durationMode('none')).toBe(PollMode.Evergreen);
    expect(durationMode('7d')).toBe(PollMode.Deadline);
    expect(isPollDuration('14d')).toBe(true);
    expect(isPollDuration('2w')).toBe(false);
    expect(isPollDuration(undefined)).toBe(false);
  });
});

describe('validatePollOptions', () => {
  it('sorts options by position and trims labels', () => {
    const result = validatePollOptions([
      { position: 2, label: ' Second ' },
      { position: 1, label: 'First' }
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.options).toEqual([
        { position: 1, label: 'First' },
        { position: 2, label: 'Second' }
      ]);
    }
  });

  it('rejects a non-array, a bad position, and an out-of-range position', () => {
    expect(validatePollOptions('nope').ok).toBe(false);
    expect(validatePollOptions([{ position: 'one', label: 'A' }, { position: 2, label: 'B' }]).ok).toBe(false);
    expect(validatePollOptions([{ position: 8, label: 'A' }, { position: 2, label: 'B' }]).ok).toBe(false);
  });
});

describe('choiceCounts', () => {
  it('withholds every option count below the ballot threshold', () => {
    const options = [
      { id: 1, label: 'One', position: 1, count: 1 },
      { id: 2, label: 'Two', position: 2, count: 0 }
    ];
    const hidden = choiceCounts(1, options, 10);
    expect(hidden.hidden).toBe(true);
    expect(hidden.counts).toBeNull();

    const visible = choiceCounts(10, options, 10);
    expect(visible.hidden).toBe(false);
    expect(visible.counts).toEqual({
      ballots: 10,
      options: [
        { id: 1, label: 'One', position: 1, count: 1 },
        { id: 2, label: 'Two', position: 2, count: 0 }
      ]
    });
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
