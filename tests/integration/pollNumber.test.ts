// The public poll number: assigned once when a poll is approved, never reused.
import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { assignPollNumber } from '../../worker/services/pollNumber';
import { applySchema, seedPoll } from './helpers';

function storedNumber(pollId: number): Promise<number | null> {
  return env.DB.prepare('SELECT number FROM polls WHERE id = ?')
    .bind(pollId).first<{ number: number | null }>().then((row) => row?.number ?? null);
}

beforeAll(async () => {
  await applySchema();
});

describe('poll number', () => {
  it('is NULL while pending, then consecutive in approval order and permanent', async () => {
    const pending = await seedPoll({ title: 'Pending proposal', status: 4 });
    const first = await seedPoll({ title: 'First published' });

    // A submission that is not approved yet consumes no public number.
    expect(await storedNumber(pending)).toBeNull();
    expect(await storedNumber(first)).toBe(1);

    // Approving the pending poll takes the next number, in approval order rather
    // than creation order: it was created first and is numbered second.
    await assignPollNumber(env.DB, pending);
    expect(await storedNumber(pending)).toBe(2);

    // The assignment is idempotent, so a retry or a re-approval cannot consume a
    // second number.
    await assignPollNumber(env.DB, pending);
    expect(await storedNumber(pending)).toBe(2);

    // A third poll continues the sequence.
    const third = await seedPoll({ title: 'Third published' });
    expect(await storedNumber(third)).toBe(3);
  });

  it('refuses to let two polls share a number', async () => {
    const a = await seedPoll({ title: 'Unique A' });
    const b = await seedPoll({ title: 'Unique B' });

    await expect(
      env.DB.prepare('UPDATE polls SET number = ? WHERE id = ?').bind(await storedNumber(a), b).run()
    ).rejects.toThrow();
  });
});
