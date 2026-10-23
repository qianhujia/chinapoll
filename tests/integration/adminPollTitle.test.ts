import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { AdminActor } from '../../admin/auth';
import { handlePollsRequest } from '../../admin/api/polls';
import { applySchema, seedPoll } from './helpers';

// The admin Worker is deployed separately and has no test harness of its own, so
// its handlers are exercised directly against the shared D1 binding.
const ACTOR: AdminActor = { id: 1, username: 'admin', role: 'admin' };

function url(path: string): URL {
  return new URL(`https://admin.example.com${path}`);
}

function titleRequest(pollId: number, body: Record<string, unknown>): Promise<Response> {
  const target = url(`/api/admin/polls/${pollId}/title`);
  return handlePollsRequest(new Request(target, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }), target, env, ACTOR);
}

async function storedTitle(pollId: number): Promise<string | null> {
  const row = await env.DB.prepare('SELECT title FROM polls WHERE id = ?')
    .bind(pollId).first<{ title: string | null }>();
  return row?.title ?? null;
}

beforeAll(async () => {
  await applySchema();
});

describe('admin poll title', () => {
  it('renames a published poll and writes an audit entry', async () => {
    // Status 1 is open: the title is editable even after publishing.
    const pollId = await seedPoll({ title: 'Original published title', status: 1 });

    const response = await titleRequest(pollId, { title: '  Corrected published title  ' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      pollId,
      title: 'Corrected published title'
    });

    // The title is trimmed and stored.
    expect(await storedTitle(pollId)).toBe('Corrected published title');

    const audit = await env.DB.prepare(
      "SELECT action, actor_username, details FROM admin_audit_log WHERE action = 'poll.title' AND target_id = ?"
    ).bind(String(pollId)).first<{ action: string; actor_username: string; details: string }>();
    expect(audit?.action).toBe('poll.title');
    expect(audit?.actor_username).toBe('admin');
    const details = JSON.parse(audit?.details ?? '{}');
    expect(details.previous).toBe('Original published title');
    expect(details.title).toBe('Corrected published title');
  });

  it('rejects an empty, missing, or over-long title', async () => {
    const pollId = await seedPoll({ title: 'Validation title poll' });

    expect((await titleRequest(pollId, { title: '   ' })).status).toBe(400);
    expect((await titleRequest(pollId, { title: 'x'.repeat(201) })).status).toBe(400);
    expect((await titleRequest(pollId, {})).status).toBe(400);
    // The rejected attempts leave the stored title untouched.
    expect(await storedTitle(pollId)).toBe('Validation title poll');
  });

  it('skips the write and the audit entry when the title is unchanged', async () => {
    const pollId = await seedPoll({ title: 'Unchanged title poll' });

    const response = await titleRequest(pollId, { title: 'Unchanged title poll' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, title: 'Unchanged title poll' });

    const audit = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM admin_audit_log WHERE action = 'poll.title' AND target_id = ?"
    ).bind(String(pollId)).first<{ total: number }>();
    expect(Number(audit?.total ?? 0)).toBe(0);
  });

  it('answers 404 for an unknown poll and 405 for the wrong method', async () => {
    expect((await titleRequest(999_999, { title: 'No such poll' })).status).toBe(404);

    // The method is checked before the poll is looked up.
    const target = url('/api/admin/polls/1/title');
    const wrongMethod = await handlePollsRequest(new Request(target, { method: 'POST' }), target, env, ACTOR);
    expect(wrongMethod.status).toBe(405);
  });
});
