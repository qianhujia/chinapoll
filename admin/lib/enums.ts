import { PollMode, PollStatus, PollReportReason } from '../../worker/enums';

export type AdminPollStatus = 'open' | 'closed' | 'archived' | 'pending';
export type AdminPollMode = 'deadline' | 'evergreen';

// Report reason codes and labels, shared with the public Worker so the admin
// Worker and the report endpoint cannot drift apart.
export const REPORT_REASON_CODES = PollReportReason;
export {
  PollMode,
  PollReportReason,
  PollStatus,
  PollType,
  PRIORITY_REPORT_REASONS,
  getPollReportReasonCode,
  getPollReportReasonLabel,
  getPollTypeCode,
  getPollTypeLabel,
  getReportResolutionCode,
  getReportResolutionLabel,
  isPriorityReportReason
} from '../../worker/enums';
export type {
  PollReportReasonLabel,
  PollTypeLabel,
  ReportResolutionLabel
} from '../../worker/enums';

export const POLL_STATUS_VALUES: Record<AdminPollStatus, PollStatus> = {
  open: PollStatus.Open,
  closed: PollStatus.Closed,
  archived: PollStatus.Archived,
  pending: PollStatus.Pending
};

export function parsePollStatus(value: string | null): AdminPollStatus | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized in POLL_STATUS_VALUES) return normalized as AdminPollStatus;
  return null;
}

// Unlike the public helper, this maps the internal Pending status used by submissions.
export function pollStatusLabel(value: number): AdminPollStatus {
  switch (value) {
    case PollStatus.Open: return 'open';
    case PollStatus.Closed: return 'closed';
    case PollStatus.Archived: return 'archived';
    case PollStatus.Pending: return 'pending';
    default: throw new Error(`Unknown poll status code: ${value}`);
  }
}

export function pollModeLabel(value: number): AdminPollMode {
  switch (value) {
    case PollMode.Deadline: return 'deadline';
    case PollMode.Evergreen: return 'evergreen';
    default: throw new Error(`Unknown poll mode code: ${value}`);
  }
}

// Label of a poll type, shared with the public Worker. A stored value that is not
// one of the two known codes falls back to the single choice shape so the
// dashboard never fails on one bad row.
export { pollTypeLabel } from '../../worker/services/pollType';
