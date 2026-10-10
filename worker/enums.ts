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

export type PollModeLabel = 'deadline' | 'evergreen';
export type PollStatusLabel = 'open' | 'closed' | 'archived';
export type VoteOptionLabel = 'approve' | 'oppose' | 'neutral';

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

export function toUnixSeconds(isoDate: string): number {
  return Math.floor(Date.parse(isoDate) / 1000);
}

export function toIsoDate(unixSeconds: number | null): string | null {
  return unixSeconds === null ? null : new Date(unixSeconds * 1000).toISOString();
}
