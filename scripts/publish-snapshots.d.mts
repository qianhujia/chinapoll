// Type declarations for `publish-snapshots.mjs` so the Node unit tests can
// import its pure helpers without enabling JavaScript type checking project wide.

export interface SnapshotJson {
  tsHourEpoch?: number;
  final?: boolean;
  [key: string]: unknown;
}

export function snapshotHour(snapshot: unknown): number;
export function resumeAfter(stored: SnapshotJson[]): number;
export function mergeSnapshots(stored: SnapshotJson[], added: SnapshotJson[]): SnapshotJson[];
