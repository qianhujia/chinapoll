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

export enum VoteOption {
  Approve = 1,
  Oppose = 2,
  Neutral = 3
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
export type VoteOptionLabel = 'approve' | 'oppose' | 'neutral';
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

export function getVoteOptionCode(value: unknown): VoteOption | null {
  if (value === 'approve') return VoteOption.Approve;
  if (value === 'oppose') return VoteOption.Oppose;
  if (value === 'neutral') return VoteOption.Neutral;
  return null;
}

export function getVoteOptionLabel(value: number): VoteOptionLabel {
  switch (value) {
    case VoteOption.Approve: return 'approve';
    case VoteOption.Oppose: return 'oppose';
    case VoteOption.Neutral: return 'neutral';
    default: throw new Error(`Unknown vote option code: ${value}`);
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

export function toIsoDate(unixSeconds: number | null): string | null {
  return unixSeconds === null ? null : new Date(unixSeconds * 1000).toISOString();
}
