export enum IssueMode {
  Deadline = 1,
  Evergreen = 2
}

export enum IssueStatus {
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

export type IssueModeLabel = 'deadline' | 'evergreen';
export type IssueStatusLabel = 'open' | 'closed' | 'archived';
export type VoteOptionLabel = 'approve' | 'oppose' | 'neutral';

export function getIssueModeCode(value: unknown): IssueMode | null {
  if (value === 'deadline') return IssueMode.Deadline;
  if (value === 'evergreen') return IssueMode.Evergreen;
  return null;
}

export function getIssueModeLabel(value: number): IssueModeLabel {
  switch (value) {
    case IssueMode.Deadline: return 'deadline';
    case IssueMode.Evergreen: return 'evergreen';
    default: throw new Error(`Unknown issue mode code: ${value}`);
  }
}

export function getIssueStatusLabel(value: number): IssueStatusLabel {
  switch (value) {
    case IssueStatus.Open: return 'open';
    case IssueStatus.Closed: return 'closed';
    case IssueStatus.Archived: return 'archived';
    default: throw new Error(`Unknown issue status code: ${value}`);
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

export function toUnixSeconds(isoDate: string): number {
  return Math.floor(Date.parse(isoDate) / 1000);
}

export function toIsoDate(unixSeconds: number | null): string | null {
  return unixSeconds === null ? null : new Date(unixSeconds * 1000).toISOString();
}
