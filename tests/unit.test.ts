import { describe, expect, it } from 'vitest';
import { SESSION_TTL_SECONDS, createSession as createAdminSession, type AdminEnv } from '../admin/auth';
import { USER_SESSION_TTL_SECONDS, createSession as createUserSession } from '../worker/services/session';
import { parseRateLimit } from '../worker/services/rateLimit';
import { ipBucket, hashedNetworkBucket, isValidServerKey } from '../worker/services/ip';
import { makeSnapshot, verifySnapshotHash, SNAPSHOT_SCHEMA_VERSION } from '../worker/services/snapshot';
import { normalizeRecoveryCode } from '../worker/services/recovery';
import { commentOwnerHash, ownerHash } from '../worker/services/owner';
import { deriveKey, fromHex, hmacSha256Hex } from '../shared/crypto';
import { checkAccountAge, validateUserPassword } from '../worker/services/users';
import { enforceSameOrigin } from '../worker/services/csrf';
import { validateProposal } from '../worker/api/proposal';
import { validatePollOptions } from '../worker/services/pollType';
import {
  toPublicResults,
  validateSelections,
  type PollOption,
  type PollTally
} from '../worker/services/options';
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

// Recomputes the HMAC of one message with the same primitives the owner service
// uses, so the golden expectations below state the message instead of a magic value.
async function ownerHashAt(message: string, keyHex: string): Promise<string> {
  return hmacSha256Hex(fromHex(await deriveKey(keyHex, 'owner')), message);
}

describe('owner hashes', () => {
  it('derives a poll owner hash from the account and the poll id', async () => {
    // If this message changes, every stored `polls.owner_hash` stops matching and
    // "my polls", close, and withdraw break for polls that already exist.
    expect(await ownerHash(1, 7, KEY)).toBe(await ownerHashAt('owner:1:7', KEY));
    expect(await ownerHash(1, 7, KEY)).toMatch(/^[0-9a-f]{64}$/);
    // The hash depends on both the account and the poll.
    expect(await ownerHash(1, 7, KEY)).not.toBe(await ownerHash(2, 7, KEY));
    expect(await ownerHash(1, 7, KEY)).not.toBe(await ownerHash(1, 8, KEY));
  });

  it('namespaces the comment hash so it cannot collide with a poll id', async () => {
    expect(await commentOwnerHash(1, 'abcdef', KEY)).toBe(await ownerHashAt('owner:1:comment:abcdef', KEY));
    // A comment whose public id looks like a poll id is a different message.
    expect(await commentOwnerHash(1, '7', KEY)).not.toBe(await ownerHash(1, 7, KEY));
  });

  it('returns null when the server key is missing or unusable', async () => {
    expect(await ownerHash(1, 7, undefined)).toBeNull();
    expect(await ownerHash(1, 7, 'too-short')).toBeNull();
    expect(await commentOwnerHash(1, 'abcdef', undefined)).toBeNull();
  });
});

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
    const first = await makeSnapshot({ pollId: 1, tsHour: 100, ballots: 4, views: 7, prevHash: null });
    expect(first.prevHash).toBe('GENESIS');
    expect(first.views).toBe(7);
    // The chain covers the ballot total and the per-option counts.
    expect(first.ballots).toBe(4);
    expect(first.optionCounts).toBeNull();
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    const recomputed = await verifySnapshotHash({
      pollId: first.pollId, tsHour: first.tsHour, ballots: first.ballots,
      optionCounts: first.optionCounts, views: first.views, prevHash: first.prevHash
    });
    expect(recomputed).toBe(first.hash);

    // The cumulative views are part of the hashed payload.
    const tampered = await verifySnapshotHash({
      pollId: first.pollId, tsHour: first.tsHour, ballots: first.ballots,
      optionCounts: first.optionCounts, views: first.views + 1, prevHash: first.prevHash
    });
    expect(tampered).not.toBe(first.hash);

    // So are the number of ballots and the per-option counts.
    const tamperedBallots = await verifySnapshotHash({
      pollId: first.pollId, tsHour: first.tsHour, ballots: first.ballots + 1,
      optionCounts: first.optionCounts, views: first.views, prevHash: first.prevHash
    });
    expect(tamperedBallots).not.toBe(first.hash);

    const choice = await makeSnapshot({
      pollId: 2,
      tsHour: 100,
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
      ballots: 4,
      optionCounts: [{ position: 2, count: 1 }, { position: 1, count: 3 }],
      views: 0,
      prevHash: null
    });
    expect(reordered.hash).toBe(choice.hash);
    const tamperedOptions = await verifySnapshotHash({
      pollId: 2, tsHour: 100, ballots: 4,
      optionCounts: [{ position: 1, count: 4 }, { position: 2, count: 1 }],
      views: 0, prevHash: 'GENESIS'
    });
    expect(tamperedOptions).not.toBe(choice.hash);

    const second = await makeSnapshot({ pollId: 1, tsHour: 101, ballots: 5, views: 9, prevHash: first.hash });
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
  // The Verdict card submits the same shape as a single choice poll: the three
  // verdict words as ordinary options next to `pollType: "verdict"`.
  const verdictTemplateOptions = [
    { position: 1, label: 'Approve' },
    { position: 2, label: 'Neutral' },
    { position: 3, label: 'Oppose' }
  ];

  it('accepts a title with no description because the description is optional', () => {
    const result = validateProposal({
      title: 'Public transit funding', pollType: 'verdict', duration: 'none', options: verdictTemplateOptions
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.description).toBeNull();
      expect(result.input.pollType).toBe(PollType.Verdict);
      expect(result.input.duration).toBe('none');
      // The verdict type's three labels are ordinary option rows.
      expect(result.input.options).toEqual(verdictTemplateOptions);
    }
  });

  it('requires a poll type that is one of the three known types', () => {
    expect(validateProposal({ title: 'No type', duration: 'none', options }).ok).toBe(false);
    expect(validateProposal({ title: 'Bad type', pollType: 'ranked', duration: 'none', options }).ok).toBe(false);

    for (const [label, expected] of [
      ['verdict', PollType.Verdict],
      ['single_choice', PollType.SingleChoice],
      ['multi_choice', PollType.MultiChoice]
    ] as const) {
      const result = validateProposal({ title: `Type ${label}`, pollType: label, duration: 'none', options });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.input.pollType).toBe(expected);
    }
  });

  it('keeps a substantive description', () => {
    const description = 'A sufficiently long description of the proposal.';
    const result = validateProposal({
      title: 'Public transit funding', pollType: 'single_choice', duration: '7d', description, options
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.description).toBe(description);
  });

  it('rejects a short non-empty description', () => {
    const result = validateProposal({
      title: 'Public transit funding', pollType: 'single_choice', duration: 'none', description: 'too short', options
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a blank title', () => {
    expect(validateProposal({ title: '   ', pollType: 'single_choice', duration: 'none', options }).ok).toBe(false);
  });

  it('requires a duration that is one of the seven labels', () => {
    expect(validateProposal({ title: 'No duration', pollType: 'single_choice', options }).ok).toBe(false);
    expect(validateProposal({
      title: 'Bad duration', pollType: 'single_choice', duration: '2w', options
    }).ok).toBe(false);
    for (const duration of POLL_DURATIONS) {
      expect(validateProposal({
        title: `Duration ${duration}`, pollType: 'single_choice', duration, options
      }).ok).toBe(true);
    }
  });

  it('accepts a single choice poll with 2 to 7 options', () => {
    const result = validateProposal({
      title: 'Preferred transit mode', pollType: 'single_choice', duration: '14d', options
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.pollType).toBe(PollType.SingleChoice);
      // Every row carries its label.
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

  it('rejects options that only keep two rows when they are identical', () => {
    // The verdict poll's list may be edited freely, but the shared rules still
    // apply: two distinct labels are the minimum.
    const result = validateProposal({
      title: 'Verdict poll', pollType: 'verdict', duration: 'none',
      options: [{ position: 1, label: 'Same' }, { position: 2, label: 'same' }]
    });
    expect(result.ok).toBe(false);
  });

  it('also rejects a verdict poll with too few options', () => {
    expect(validateProposal({
      title: 'Verdict poll', pollType: 'verdict', duration: 'none',
      options: [{ position: 1, label: 'Approve' }]
    }).ok).toBe(false);
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
    expect(() => getPollTypeLabel(4)).toThrow();
  });

  it('maps the duration labels to days, seconds, and a poll mode', () => {
    expect(POLL_DURATIONS).toEqual(['none', '1d', '3d', '7d', '14d', '1m', '6m', '1y']);
    expect(durationSeconds('none')).toBeNull();
    expect(durationSeconds('1d')).toBe(86_400);
    expect(durationSeconds('1m')).toBe(30 * 86_400);
    // Half a year is 180 days, so the stored length stays a whole number of days.
    expect(durationSeconds('6m')).toBe(180 * 86_400);
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
      // Every row carries its label.
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
describe('shared options engine', () => {
  const single = { id: 2, poll_type: 2 };
  const verdict = { id: 1, poll_type: 1 };

  // The stored rows of a poll: a label for every row.
  const stored: PollOption[] = [
    { id: 11, position: 1, label: 'Bus' },
    { id: 12, position: 2, label: 'Metro' },
    { id: 13, position: 3, label: 'Bike' }
  ];

  // A verdict poll's rows are the three verdict words. Its type is its own, and it
  // takes the same single ballot as a single choice poll.
  const verdictTemplate: PollOption[] = [
    { id: 21, position: 1, label: 'Approve' },
    { id: 22, position: 2, label: 'Neutral' },
    { id: 23, position: 3, label: 'Oppose' }
  ];

  it('takes exactly one option for both a single choice poll and a verdict poll', () => {
    expect(validateSelections(single, stored, { optionIds: [12] })).toEqual({ ok: true, optionIds: [12] });
    expect(validateSelections(verdict, verdictTemplate, { optionIds: [23] })).toEqual({ ok: true, optionIds: [23] });

    for (const poll of [single, verdict]) {
      const options = poll === single ? stored : verdictTemplate;
      expect(validateSelections(poll, options, { optionIds: [] }).ok).toBe(false);
      expect(validateSelections(poll, options, { optionIds: [options[0].id, options[1].id] }).ok).toBe(false);
      expect(rejectionMessage(validateSelections(poll, options, { optionIds: [options[0].id, options[0].id] })))
        .toBe('duplicate option');
      expect(rejectionMessage(validateSelections(poll, options, { optionIds: [999] }))).toBe('unknown option');
    }

    // The removed legacy verdict label is a bad request, not a selection.
    expect(rejectionMessage(validateSelections(verdict, verdictTemplate, { option: 'approve' }))).toBe('bad request');
    expect(rejectionMessage(validateSelections(verdict, verdictTemplate, {}))).toBe('bad request');
  });
});

describe('shared options engine results', () => {
  const stored: PollOption[] = [
    { id: 11, position: 1, label: 'Bus' },
    { id: 12, position: 2, label: 'Metro' },
    { id: 13, position: 3, label: 'Bike' }
  ];
  const verdictTemplate: PollOption[] = [
    { id: 21, position: 1, label: 'Approve' },
    { id: 22, position: 2, label: 'Neutral' },
    { id: 23, position: 3, label: 'Oppose' }
  ];

  it('accepts one to many stored options for a multiple choice poll', () => {
    const multi = { id: 3, poll_type: 3 };
    expect(validateSelections(multi, stored, { optionIds: [11] })).toEqual({ ok: true, optionIds: [11] });
    expect(validateSelections(multi, stored, { optionIds: [11, 13] })).toEqual({ ok: true, optionIds: [11, 13] });
    expect(validateSelections(multi, stored, { optionIds: [] }).ok).toBe(false);
    // Duplicates and unknown ids are refused.
    expect(validateSelections(multi, stored, { optionIds: [11, 11] }).ok).toBe(false);
    expect(rejectionMessage(validateSelections(multi, stored, { optionIds: [11, 999] }))).toBe('unknown option');
    // A non-array payload is a bad request rather than a crash.
    expect(validateSelections(multi, stored, { optionIds: 'nope' }).ok).toBe(false);
  });

  it('returns one results shape for every poll and hides all counts below the threshold', () => {
    const tally: PollTally = { ballots: 4, counts: new Map([[11, 3], [12, 1]]) };
    const visible = toPublicResults({ poll_type: 2 }, stored, tally, 4);
    expect(visible).toEqual({
      pollType: 'single_choice',
      ballots: 4,
      hidden: false,
      threshold: 4,
      options: [
        { id: 11, position: 1, label: 'Bus', count: 3 },
        { id: 12, position: 2, label: 'Metro', count: 1 },
        { id: 13, position: 3, label: 'Bike', count: 0 }
      ]
    });

    // Below the threshold every option count is withheld together, while the
    // ballot total is still reported.
    const hidden = toPublicResults({ poll_type: 2 }, stored, tally, 10);
    expect(hidden.hidden).toBe(true);
    expect(hidden.options).toBeNull();
    expect(hidden.ballots).toBe(4);

    // A verdict poll uses the same shape with its three labeled rows, and reports
    // its own type.
    const templateTally: PollTally = { ballots: 7, counts: new Map([[21, 5], [23, 2]]) };
    const templateResults = toPublicResults({ poll_type: 1 }, verdictTemplate, templateTally, 0);
    expect(templateResults.pollType).toBe('verdict');
    expect(templateResults.options?.map((option) => [option.label, option.count])).toEqual([
      ['Approve', 5],
      ['Neutral', 0],
      ['Oppose', 2]
    ]);
  });
});



// Reads the rejection message of a selection result, failing the test if the
// selection was accepted.
function rejectionMessage(result: { ok: true; optionIds: number[] } | { ok: false; message: string }): string {
  expect(result.ok).toBe(false);
  return result.ok ? '' : result.message;
}


describe('snapshot schema version', () => {
  it('writes and verifies the single schema version 3 payload', async () => {
    // There is one canonical format: schema version 3 covers the ballots and the
    // per-option counts only.
    const modern = await makeSnapshot({
      pollId: 5,
      tsHour: 10,
      ballots: 3,
      optionCounts: [{ position: 1, count: 2 }, { position: 2, count: 1 }],
      views: 3,
      prevHash: null
    });
    expect(SNAPSHOT_SCHEMA_VERSION).toBe(3);
    expect(modern.ballots).toBe(3);
    // The legacy verdict counts no longer exist on a record.
    expect(modern).not.toHaveProperty('approve');
    expect(modern).not.toHaveProperty('oppose');
    expect(modern).not.toHaveProperty('neutral');
    expect(await verifySnapshotHash({
      pollId: modern.pollId,
      tsHour: modern.tsHour,
      ballots: modern.ballots,
      optionCounts: modern.optionCounts,
      views: modern.views,
      prevHash: modern.prevHash
    })).toBe(modern.hash);
  });
});

// A D1 stand-in that records every bound statement, so a test can inspect the
// values a session insert would write without touching a database.
interface RecordedStatement {
  sql: string;
  binds: unknown[];
}

function recordingDb(recorded: RecordedStatement[]): D1Database {
  return {
    prepare(sql: string) {
      const statement = {
        binds: [] as unknown[],
        bind(...args: unknown[]) {
          statement.binds = args;
          recorded.push({ sql, binds: args });
          return statement;
        }
      };
      return statement;
    },
    batch: async (statements: unknown[]) => statements
  } as unknown as D1Database;
}

function boundInsert(recorded: RecordedStatement[], table: string): RecordedStatement {
  const statement = recorded.find((entry) => entry.sql.includes(`INSERT INTO ${table}`));
  if (!statement) throw new Error(`no insert into ${table} was bound`);
  return statement;
}

describe('session timestamps', () => {
  it('writes created_at at hour resolution for a user session', async () => {
    const recorded: RecordedStatement[] = [];
    await createUserSession({ DB: recordingDb(recorded) }, 7);

    const insert = boundInsert(recorded, 'user_sessions');
    const createdAt = Number(insert.binds[2]);
    const expiresAt = Number(insert.binds[3]);
    expect(createdAt % 3600).toBe(0);
    // Only the creation time is coarsened: the sliding expiry stays exact.
    expect(expiresAt - createdAt).toBeGreaterThanOrEqual(USER_SESSION_TTL_SECONDS);
    expect(expiresAt - createdAt).toBeLessThan(USER_SESSION_TTL_SECONDS + 3600);
  });

  it('writes created_at at hour resolution for an admin session', async () => {
    const recorded: RecordedStatement[] = [];
    await createAdminSession({ DB: recordingDb(recorded) } as unknown as AdminEnv, 7);

    const insert = boundInsert(recorded, 'admin_sessions');
    const createdAt = Number(insert.binds[2]);
    const expiresAt = Number(insert.binds[3]);
    expect(createdAt % 3600).toBe(0);
    expect(expiresAt - createdAt).toBeGreaterThanOrEqual(SESSION_TTL_SECONDS);
    expect(expiresAt - createdAt).toBeLessThan(SESSION_TTL_SECONDS + 3600);
    // The single-session policy drops the admin's other sessions in the same batch.
    expect(recorded.some((entry) => entry.sql.includes('DELETE FROM admin_sessions WHERE admin_user_id = ?'))).toBe(true);
  });
});

