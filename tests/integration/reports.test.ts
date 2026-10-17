import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applySchema, reportRequest, seedPoll } from './helpers';

interface PollRow {
  status: number;
  reviewed_at: number | null;
}

function pollRow(pollId: number): Promise<PollRow | null> {
  return env.DB.prepare('SELECT status, reviewed_at FROM polls WHERE id = ?')
    .bind(pollId).first<PollRow>();
}

beforeAll(async () => {
  await applySchema();
  // Raise the report rate limit so the functional tests below are not throttled.
  // The default limit is exercised in reportRateLimit.test.ts.
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('report_rate_limit', '1000/d')").run();
});

describe('poll report endpoint', () => {
  it('accepts an anonymous report with an hour-coarsened timestamp and no reporter data', async () => {
    const pollId = await seedPoll({ title: 'Reportable poll' });

    const response = await reportRequest(pollId, 'spam');
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });

    const row = await env.DB.prepare(
      'SELECT reason, note, created_at, resolved_at, resolution FROM poll_reports WHERE poll_id = ?'
    ).bind(pollId).first<{ reason: number; note: string | null; created_at: number; resolved_at: number | null; resolution: number | null }>();
    expect(row?.reason).toBe(1);
    expect(row?.note).toBeNull();
    expect((row?.created_at ?? 0) % 3600).toBe(0);
    expect(row?.resolved_at).toBeNull();
    expect(row?.resolution).toBeNull();
  });

  it('accepts a note only with reason "other" and caps its length', async () => {
    const pollId = await seedPoll({ title: 'Note poll' });

    expect((await reportRequest(pollId, 'spam', 'not allowed')).status).toBe(400);
    expect((await reportRequest(pollId, 'other', 'x'.repeat(301))).status).toBe(400);
    expect((await reportRequest(pollId, 'other', 'A useful note')).status).toBe(201);

    const row = await env.DB.prepare('SELECT note FROM poll_reports WHERE poll_id = ?')
      .bind(pollId).first<{ note: string | null }>();
    expect(row?.note).toBe('A useful note');
  });

  it('rejects an unknown reason', async () => {
    const pollId = await seedPoll({ title: 'Bad reason poll' });
    expect((await reportRequest(pollId, 'nonsense')).status).toBe(400);
  });

  it('returns 404 for a pending poll and for a missing poll', async () => {
    const pendingId = await seedPoll({ title: 'Pending poll', status: 4 });
    expect((await reportRequest(pendingId, 'spam')).status).toBe(404);
    expect((await reportRequest(999_999, 'spam')).status).toBe(404);
  });

  it('auto-hides a poll once the priority threshold is reached', async () => {
    const pollId = await seedPoll({ title: 'Priority poll', reviewedAt: 1 });

    expect((await reportRequest(pollId, 'harassment')).status).toBe(201);
    expect((await pollRow(pollId))?.status).toBe(1);

    expect((await reportRequest(pollId, 'personal_info')).status).toBe(201);
    const hidden = await pollRow(pollId);
    expect(hidden?.status).toBe(4);
    expect(hidden?.reviewed_at).toBeNull();

    const audit = await env.DB.prepare(
      "SELECT action, actor_id, details FROM admin_audit_log WHERE action = 'poll.auto_hidden' AND target_id = ?"
    ).bind(String(pollId)).first<{ action: string; actor_id: number | null; details: string }>();
    expect(audit?.action).toBe('poll.auto_hidden');
    expect(audit?.actor_id).toBeNull();
    expect(JSON.parse(audit?.details ?? '{}')).toMatchObject({ priorityReports: 2 });
  });

  it('auto-hides a poll once the total threshold is reached', async () => {
    const pollId = await seedPoll({ title: 'Total poll' });

    for (let index = 0; index < 4; index += 1) {
      expect((await reportRequest(pollId, 'spam')).status).toBe(201);
    }
    expect((await pollRow(pollId))?.status).toBe(1);

    expect((await reportRequest(pollId, 'spam')).status).toBe(201);
    expect((await pollRow(pollId))?.status).toBe(4);
  });
});
