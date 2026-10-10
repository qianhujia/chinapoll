export type VoteOption = 'approve' | 'oppose' | 'neutral';

export interface SnapshotRecord {
  pollId: number;
  tsHour: string;
  approve: number;
  oppose: number;
  neutral: number;
  prevHash: string;
}

export interface SnapshotInput {
  pollId: number;
  tsHour: string;
  counts: Record<VoteOption, number>;
  prevHash: string | null;
}

export function makeSnapshot({ pollId, tsHour, counts, prevHash }: SnapshotInput): SnapshotRecord {
  const payload = JSON.stringify({
    pollId,
    tsHour,
    approve: counts.approve ?? 0,
    oppose: counts.oppose ?? 0,
    neutral: counts.neutral ?? 0,
    prevHash: prevHash ?? 'GENESIS'
  });

  return {
    pollId,
    tsHour,
    approve: counts.approve ?? 0,
    oppose: counts.oppose ?? 0,
    neutral: counts.neutral ?? 0,
    prevHash: prevHash ?? hashPayload(payload)
  };
}

function hashPayload(value: string): string {
  return value
    .split('')
    .reduce((hash, char) => {
      return (hash * 31 + char.charCodeAt(0)) >>> 0;
    }, 0)
    .toString(16);
}
