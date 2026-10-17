import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { AdminActor } from '../../admin/auth';
import { handleReportsRequest } from '../../admin/api/reports';
import { applySchema, reportRequest, seedPoll } from './helpers';

// The admin Worker is deployed separately and has no test harness of its own, so
// its handlers are exercised directly against the shared D1 binding. Auth and
// CSRF are enforced in admin/index.ts, not in the handlers.
const ACTOR: AdminActor = { id: 1, username: 'admin', role: 'admin' };

function listUrl(query = ''): URL {
  return new URL(`https://admin.example.com/api/admin/reports${query}`);
}

function resolveRequest(resolution: string): Request {
  return new Request('https://admin.example.com/api/admin/reports/1/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ resolution })
  });
}

function resolveUrl(pollId: number): URL {
  return new URL(`https://admin.example.com/api/admin/reports/${pollId}/resolve`);
}

beforeAll(async () => {
  await applySchema();
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('report_rate_limit', '1000/d')").run();
});

describe('admin report moderation', () => {
  it('lists polls with reports, priority polls first', async () => {
    const priorityPoll = await seedPoll({ title: 'Priority report poll' });
    const normalPoll = await seedPoll({ title: 'Normal report poll' });
    await reportRequest(priorityPoll, 'harassment');
    await reportRequest(priorityPoll, 'other', 'A note for moderation');
    await reportRequest(normalPoll, 'spam');

    const response = await handleReportsRequest(
      new Request(listUrl('?status=open&pageSize=50').toString()),
      listUrl('?status=open&pageSize=50'),
      env,
      ACTOR
    );
    expect(response.status).toBe(200);

    const body = await response.json() as any;
    const rows = body.reports as any[];
    const priorityRow = rows.find((row) => row.pollId === priorityPoll);
    const normalRow = rows.find((row) => row.pollId === normalPoll);

    expect(rows[0].pollId).toBe(priorityPoll);
    expect(priorityRow).toMatchObject({ openCount: 2, totalCount: 2, priority: true });
    expect(priorityRow.notes).toEqual(['A note for moderation']);
    expect(priorityRow.reasons).toHaveLength(8);
    expect(priorityRow.reasons[0]).toEqual({ reason: 'harassment', count: 1 });
    expect(normalRow).toMatchObject({ openCount: 1, totalCount: 1, priority: false });
    // The public JSON never carries a reporter.
    expect(JSON.stringify(body)).not.toContain('user');
  });

  it('resolves every open report without changing the poll status', async () => {
    const pollId = await seedPoll({ title: 'Resolvable poll' });
    await reportRequest(pollId, 'spam');
    await reportRequest(pollId, 'spam');

    const response = await handleReportsRequest(
      resolveRequest('action_taken'),
      resolveUrl(pollId),
      env,
      ACTOR
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, pollId, resolution: 'action_taken', resolved: 2 });

    const open = await env.DB.prepare(
      'SELECT COUNT(*) AS total FROM poll_reports WHERE poll_id = ? AND resolved_at IS NULL'
    ).bind(pollId).first<{ total: number }>();
    expect(open?.total).toBe(0);

    const resolved = await env.DB.prepare(
      'SELECT resolved_at, resolution FROM poll_reports WHERE poll_id = ? LIMIT 1'
    ).bind(pollId).first<{ resolved_at: number; resolution: number }>();
    expect((resolved?.resolved_at ?? 0) % 3600).toBe(0);
    expect(resolved?.resolution).toBe(2);

    const poll = await env.DB.prepare('SELECT status FROM polls WHERE id = ?')
      .bind(pollId).first<{ status: number }>();
    expect(poll?.status).toBe(1);

    const audit = await env.DB.prepare(
      "SELECT action, actor_username FROM admin_audit_log WHERE action = 'report.resolved' AND target_id = ?"
    ).bind(String(pollId)).first<{ action: string; actor_username: string }>();
    expect(audit).toMatchObject({ action: 'report.resolved', actor_username: 'admin' });

    // The resolved filter now lists the poll and the open filter does not.
    const resolvedList = await handleReportsRequest(
      new Request(listUrl('?status=resolved').toString()), listUrl('?status=resolved'), env, ACTOR
    );
    expect((await resolvedList.json() as any).reports.map((row: any) => row.pollId)).toContain(pollId);

    const openList = await handleReportsRequest(
      new Request(listUrl('?status=open&pageSize=100').toString()), listUrl('?status=open&pageSize=100'), env, ACTOR
    );
    expect((await openList.json() as any).reports.map((row: any) => row.pollId)).not.toContain(pollId);
  });

  it('rejects a bad resolution, a missing poll, and a poll with no open reports', async () => {
    const pollId = await seedPoll({ title: 'Already clean poll' });

    const bad = await handleReportsRequest(resolveRequest('nonsense'), resolveUrl(pollId), env, ACTOR);
    expect(bad.status).toBe(400);

    const missing = await handleReportsRequest(resolveRequest('dismissed'), resolveUrl(999_999), env, ACTOR);
    expect(missing.status).toBe(404);

    const empty = await handleReportsRequest(resolveRequest('dismissed'), resolveUrl(pollId), env, ACTOR);
    expect(empty.status).toBe(409);
  });

  it('rejects an invalid status filter and pagination', async () => {
    const badStatus = await handleReportsRequest(
      new Request(listUrl('?status=nope').toString()), listUrl('?status=nope'), env, ACTOR
    );
    expect(badStatus.status).toBe(400);

    const badPage = await handleReportsRequest(
      new Request(listUrl('?page=0').toString()), listUrl('?page=0'), env, ACTOR
    );
    expect(badPage.status).toBe(400);
  });
});
