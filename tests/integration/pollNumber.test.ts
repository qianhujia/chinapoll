// The public poll number: assigned once when a poll is approved, never reused.
import { beforeAll, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { assignPollNumber } from '../../worker/services/pollNumber';
import { ORIGIN, applySchema, seedPoll } from './helpers';

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

  // The number is the identifier the site publishes, so every public link and the
  // route itself follow it even when it is far from the primary key.
  it('links and resolves by number when it differs from the primary key', async () => {
    const older = await seedPoll({ title: 'Older numbered poll' });
    const newer = await seedPoll({ title: 'Newer numbered poll' });
    await env.DB.prepare('UPDATE polls SET number = 9001 WHERE id = ?').bind(older).run();
    await env.DB.prepare('UPDATE polls SET number = 9002 WHERE id = ?').bind(newer).run();

    // The detail route resolves the number, and the response still carries the
    // internal id that the vote, comment, and view calls use.
    const detail = await (await SELF.fetch(`${ORIGIN}/api/polls/9001`)).json() as {
      poll: { id: number; number: number };
    };
    expect(detail.poll.id).toBe(older);
    expect(detail.poll.number).toBe(9001);

    // The server-rendered list links the number and never the primary key.
    const home = await (await SELF.fetch(`${ORIGIN}/`)).text();
    expect(home).toContain('href="/poll/9001"');
    expect(home).not.toContain(`href="/poll/${older}"`);

    // The poll page's canonical URL and its previous/next links follow the numbers
    // as well.
    const page = await (await SELF.fetch(`${ORIGIN}/poll/9001`)).text();
    expect(page).toContain(`rel="canonical" href="${ORIGIN}/poll/9001"`);
    expect(page).toContain('href="/poll/9002"');
    expect(page).toContain('#9002 Newer numbered poll');
    expect(page).not.toContain(`href="/poll/${newer}"`);
  });
});
