// Deadline badge tests.
//
// The badge beside a poll title names the time a deadline poll has left. The wording
// comes from `timeLeftUntil` and `deadlineBadgeLabel`, which are pure: they take the
// moment the page was rendered as an argument, so a test pins that moment instead of
// racing the clock.

import { describe, expect, it } from 'vitest';
import { deadlineBadgeLabel, timeLeftUntil } from '../shared/deadline';

// The subset of `public/i18n/en.json` the badge reads, so the assertions below read
// the same wording a visitor sees.
const DICTIONARY: Record<string, string> = {
  deadline: 'Time-limited',
  timeLeftDay: '1 day left',
  timeLeftDays: '{n} days left',
  timeLeftHour: '1 hour left',
  timeLeftHours: '{n} hours left',
  timeLeftMinute: '1 minute left',
  timeLeftMinutes: '{n} minutes left',
  timeLeftUnderMinute: 'Less than a minute left',
  timeLeftEnded: 'Ended'
};

const t = (key: string): string => DICTIONARY[key] ?? key;

const NOW = Date.parse('2026-10-27T12:00:00.000Z');
const fromNow = (ms: number): string => new Date(NOW + ms).toISOString();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('timeLeftUntil', () => {
  it('picks the largest whole unit that still fits', () => {
    // A day and an hour still reads in days, so the badge does not churn as the
    // hours pass.
    expect(timeLeftUntil(fromNow(13 * DAY + HOUR), NOW)).toEqual({ key: 'timeLeftDays', value: 13 });
    expect(timeLeftUntil(fromNow(5 * HOUR + MINUTE), NOW)).toEqual({ key: 'timeLeftHours', value: 5 });
    expect(timeLeftUntil(fromNow(50 * MINUTE), NOW)).toEqual({ key: 'timeLeftMinutes', value: 50 });
  });

  it('uses the singular key for exactly one unit', () => {
    expect(timeLeftUntil(fromNow(DAY), NOW)).toEqual({ key: 'timeLeftDay', value: 1 });
    expect(timeLeftUntil(fromNow(HOUR), NOW)).toEqual({ key: 'timeLeftHour', value: 1 });
    expect(timeLeftUntil(fromNow(MINUTE), NOW)).toEqual({ key: 'timeLeftMinute', value: 1 });
  });

  it('marks the last minute and the end without naming a number', () => {
    expect(timeLeftUntil(fromNow(30_000), NOW)).toEqual({ key: 'timeLeftUnderMinute', value: 0 });
    // The moment the end is reached, and every moment after it.
    expect(timeLeftUntil(fromNow(0), NOW)).toEqual({ key: 'timeLeftEnded', value: 0 });
    expect(timeLeftUntil(fromNow(-DAY), NOW)).toEqual({ key: 'timeLeftEnded', value: 0 });
  });

  it('reports nothing for a poll without a usable end date', () => {
    expect(timeLeftUntil(null, NOW)).toBeNull();
    expect(timeLeftUntil(undefined, NOW)).toBeNull();
    expect(timeLeftUntil('', NOW)).toBeNull();
    expect(timeLeftUntil('not a date', NOW)).toBeNull();
  });
});

describe('deadlineBadgeLabel', () => {
  it('fills the number into the unit the poll is in', () => {
    expect(deadlineBadgeLabel(fromNow(13 * DAY + HOUR), NOW, t)).toBe('13 days left');
    expect(deadlineBadgeLabel(fromNow(5 * HOUR + MINUTE), NOW, t)).toBe('5 hours left');
    expect(deadlineBadgeLabel(fromNow(50 * MINUTE), NOW, t)).toBe('50 minutes left');
    expect(deadlineBadgeLabel(fromNow(DAY), NOW, t)).toBe('1 day left');
  });

  it('keeps the plain mode label when there is nothing to count down to', () => {
    // No end date at all, and an end date that cannot be read, both fall back to the
    // label the badge carried before.
    expect(deadlineBadgeLabel(null, NOW, t)).toBe('Time-limited');
    expect(deadlineBadgeLabel('not a date', NOW, t)).toBe('Time-limited');
  });

  it('names the end once the deadline has passed', () => {
    expect(deadlineBadgeLabel(fromNow(-MINUTE), NOW, t)).toBe('Ended');
  });
});
