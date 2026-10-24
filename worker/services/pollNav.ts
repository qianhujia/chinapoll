// Previous/next navigation for the poll detail page.
//
// The neighbors are read from a poll's position in the same ordering the poll
// list uses (created_at DESC, id DESC) over the polls the detail page may show
// (deadline or evergreen, and open, closed, or archived). They are computed on
// demand instead of being stored as `prev_poll_id`/`next_poll_id` columns: a
// stored pair would have to be rewritten on every insert, delete, and status
// change and could silently drift, while each direction here is a single indexed
// row read (idx_polls_status_created), so the dynamic form is both simpler and
// always consistent with the list.

import { PollMode, PollStatus } from '../enums';

export interface PollNeighbor {
  id: number;
  /** The public number, used for the link; the id stays internal. */
  number: number;
  title: string;
}

export interface PollNeighbors {
  /** The older neighbor, or null at the oldest end of the list. */
  prev: PollNeighbor | null;
  /** The newer neighbor, or null at the newest end of the list. */
  next: PollNeighbor | null;
}

// The predicate that decides which polls are publicly visible, matching the
// detail query in GET /api/polls/<id> and in loadPollSsrData. A neighbor that is
// pending (or otherwise not public) is skipped, so the links never lead to a 404.
export async function loadPollNeighbors(
  db: D1Database,
  pollId: number,
  createdAt: number
): Promise<PollNeighbors> {
  const [prev, next] = await Promise.all([
    db.prepare(
      `SELECT id, number, title FROM polls
       WHERE mode IN (?, ?) AND status IN (?, ?, ?)
         AND (created_at < ? OR (created_at = ? AND id < ?))
       ORDER BY created_at DESC, id DESC LIMIT 1`
    ).bind(
      PollMode.Deadline, PollMode.Evergreen,
      PollStatus.Open, PollStatus.Closed, PollStatus.Archived,
      createdAt, createdAt, pollId
    ).first<PollNeighbor>(),
    db.prepare(
      `SELECT id, number, title FROM polls
       WHERE mode IN (?, ?) AND status IN (?, ?, ?)
         AND (created_at > ? OR (created_at = ? AND id > ?))
       ORDER BY created_at ASC, id ASC LIMIT 1`
    ).bind(
      PollMode.Deadline, PollMode.Evergreen,
      PollStatus.Open, PollStatus.Closed, PollStatus.Archived,
      createdAt, createdAt, pollId
    ).first<PollNeighbor>()
  ]);

  return { prev: prev ?? null, next: next ?? null };
}
