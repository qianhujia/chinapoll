// The public poll number.
//
// `polls.id` is the surrogate key that every foreign key and the owner hash use, so
// it cannot be the identifier a visitor sees: it is consumed by submissions that are
// never approved, and a table rebuild could renumber it. `number` is decoupled from
// it, assigned exactly once when a poll is approved, and never reused or renumbered.
// A pending poll has no number (NULL).
//
// The assignment is a single statement, so it is atomic under SQLite's single-writer
// model and needs no lock: the `MAX(number) + 1` read and the write happen inside the
// same statement, so two concurrent approvals cannot read the same maximum. The
// `number IS NULL` guard makes it idempotent, so a retry, a re-approval, or reopening
// a closed poll cannot consume a second number, and the unique index turns any
// duplicate into an error instead of two polls sharing one number.
export const ASSIGN_POLL_NUMBER_SQL =
  `UPDATE polls
   SET number = (SELECT COALESCE(MAX(number), 0) + 1 FROM polls)
   WHERE id = ? AND number IS NULL`;

// The assignment as a prepared statement, so a caller can place it in the same
// `batch` as the write that approves the poll.
export function pollNumberStatement(db: D1Database, pollId: number): D1PreparedStatement {
  return db.prepare(ASSIGN_POLL_NUMBER_SQL).bind(pollId);
}

export async function assignPollNumber(db: D1Database, pollId: number): Promise<void> {
  await pollNumberStatement(db, pollId).run();
}
