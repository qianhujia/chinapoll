export enum PollMode {
  Deadline = 1,
  Evergreen = 2
}

export enum PollStatus {
  Open = 1,
  Closed = 2,
  Archived = 3,
  Pending = 4
}

// Ballot shape of a poll. There are three: the verdict poll (a single-answer poll
// whose options the proposal form pre-fills with Approve, Neutral, and Oppose), a
// single choice poll (one option per ballot), and a multiple choice poll (one to
// seven options per ballot). The verdict type keeps its own code and its own
// options, but it accepts exactly the same ballots as a single choice poll.
export enum PollType {
  Verdict = 1,
  SingleChoice = 2,
  MultiChoice = 3
}

// Reasons a visitor can report a poll. Codes 5, 6, and 7 (personal information,
// harassment, illegal content) are treated as high priority by moderation.
export enum PollReportReason {
  Spam = 1,
  Inappropriate = 2,
  Misleading = 3,
  Copyright = 4,
  PersonalInfo = 5,
  Harassment = 6,
  Illegal = 7,
  Other = 8
}

// Resolution recorded when every open report for a poll is closed by an admin.
export enum ReportResolution {
  Dismissed = 1,
  ActionTaken = 2
}

export type PollModeLabel = 'deadline' | 'evergreen';
export type PollStatusLabel = 'open' | 'closed' | 'archived';
export type PollTypeLabel = 'verdict' | 'single_choice' | 'multi_choice';
export type PollReportReasonLabel =
  | 'spam'
  | 'inappropriate'
  | 'misleading'
  | 'copyright'
  | 'personal_info'
  | 'harassment'
  | 'illegal'
  | 'other';
export type ReportResolutionLabel = 'dismissed' | 'action_taken';

// Reason codes that moderation always reviews first.
export const PRIORITY_REPORT_REASONS: ReadonlyArray<PollReportReason> = [
  PollReportReason.PersonalInfo,
  PollReportReason.Harassment,
  PollReportReason.Illegal
];

export function getPollModeCode(value: unknown): PollMode | null {
  if (value === 'deadline') return PollMode.Deadline;
  if (value === 'evergreen') return PollMode.Evergreen;
  return null;
}

export function getPollModeLabel(value: number): PollModeLabel {
  switch (value) {
    case PollMode.Deadline: return 'deadline';
    case PollMode.Evergreen: return 'evergreen';
    default: throw new Error(`Unknown poll mode code: ${value}`);
  }
}

export function getPollStatusLabel(value: number): PollStatusLabel {
  switch (value) {
    case PollStatus.Open: return 'open';
    case PollStatus.Closed: return 'closed';
    case PollStatus.Archived: return 'archived';
    default: throw new Error(`Unknown poll status code: ${value}`);
  }
}

// Ballot shapes a proposal can select. The verdict type is its own code: it keeps
// its identity and its own option rows while accepting single choice ballots.
export function getPollTypeCode(value: unknown): PollType | null {
  switch (value) {
    case 'verdict': return PollType.Verdict;
    case 'single_choice': return PollType.SingleChoice;
    case 'multi_choice': return PollType.MultiChoice;
    default: return null;
  }
}

export function getPollTypeLabel(value: number): PollTypeLabel {
  switch (value) {
    case PollType.Verdict: return 'verdict';
    case PollType.SingleChoice: return 'single_choice';
    case PollType.MultiChoice: return 'multi_choice';
    default: throw new Error(`Unknown poll type code: ${value}`);
  }
}

export function getPollReportReasonCode(value: unknown): PollReportReason | null {
  switch (value) {
    case 'spam': return PollReportReason.Spam;
    case 'inappropriate': return PollReportReason.Inappropriate;
    case 'misleading': return PollReportReason.Misleading;
    case 'copyright': return PollReportReason.Copyright;
    case 'personal_info': return PollReportReason.PersonalInfo;
    case 'harassment': return PollReportReason.Harassment;
    case 'illegal': return PollReportReason.Illegal;
    case 'other': return PollReportReason.Other;
    default: return null;
  }
}

export function getPollReportReasonLabel(value: number): PollReportReasonLabel {
  switch (value) {
    case PollReportReason.Spam: return 'spam';
    case PollReportReason.Inappropriate: return 'inappropriate';
    case PollReportReason.Misleading: return 'misleading';
    case PollReportReason.Copyright: return 'copyright';
    case PollReportReason.PersonalInfo: return 'personal_info';
    case PollReportReason.Harassment: return 'harassment';
    case PollReportReason.Illegal: return 'illegal';
    case PollReportReason.Other: return 'other';
    default: throw new Error(`Unknown poll report reason code: ${value}`);
  }
}

// True for the reason codes that moderation treats as high priority.
export function isPriorityReportReason(value: number): boolean {
  return PRIORITY_REPORT_REASONS.includes(value as PollReportReason);
}

export function getReportResolutionCode(value: unknown): ReportResolution | null {
  switch (value) {
    case 'dismissed': return ReportResolution.Dismissed;
    case 'action_taken': return ReportResolution.ActionTaken;
    default: return null;
  }
}

export function getReportResolutionLabel(value: number): ReportResolutionLabel {
  switch (value) {
    case ReportResolution.Dismissed: return 'dismissed';
    case ReportResolution.ActionTaken: return 'action_taken';
    default: throw new Error(`Unknown report resolution code: ${value}`);
  }
}

export function toUnixSeconds(isoDate: string): number {
  return Math.floor(Date.parse(isoDate) / 1000);
}

// The proposal form offers a fixed set of durations instead of a start and end
// time. The mapping lives here so the Worker and the frontend cannot drift
// apart (src/lib/poll.ts re-exports it).
export const POLL_DURATION_DAYS: Readonly<Record<PollDuration, number | null>> = {
  none: null,
  '1d': 1,
  '3d': 3,
  '7d': 7,
  '14d': 14,
  '1m': 30,
  '6m': 180,
  '1y': 365
};

// The durations the proposal form offers. A month counts as 30 days and half a
// year as 180, so the stored lengths stay exact multiples of a day.
export type PollDuration = 'none' | '1d' | '3d' | '7d' | '14d' | '1m' | '6m' | '1y';

export type PollDurationOption = { value: PollDuration; label: string };

// Order in which the durations are offered in the form.
export const POLL_DURATIONS: ReadonlyArray<PollDuration> = [
  'none',
  '1d',
  '3d',
  '7d',
  '14d',
  '1m',
  '6m',
  '1y'
];

export const POLL_DURATION_OPTIONS: ReadonlyArray<PollDurationOption> = POLL_DURATIONS.map((value) => ({
  value,
  label: value
}));

export function isPollDuration(value: unknown): value is PollDuration {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(POLL_DURATION_DAYS, value);
}

// Seconds a duration stands for, or null when the poll never ends.
export function durationSeconds(value: PollDuration): number | null {
  const days = POLL_DURATION_DAYS[value];
  return days === null ? null : days * 86400;
}

// `none` is an evergreen poll; every other duration is a deadline poll.
export function durationMode(value: PollDuration): PollMode {
  return value === 'none' ? PollMode.Evergreen : PollMode.Deadline;
}

export function toIsoDate(unixSeconds: number | null): string | null {
  return unixSeconds === null ? null : new Date(unixSeconds * 1000).toISOString();
}
