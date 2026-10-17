import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { AdminActor } from '../../admin/auth';
import { handlePollsRequest } from '../../admin/api/polls';
import { applySchema, seedOptions, seedPoll } from './helpers';

// The admin Worker is deployed separately and has no test harness of its own, so
// its handlers are exercised directly against the shared D1 binding.
const ACTOR: AdminActor = { id: 1, username: 'admin', role: 'admin' };

function url(path: string): URL {
  return new URL(`https://admin.example.com${path}`);
}

function optionsRequest(pollId: number, options: Array<{ position: number; label: string }>): Promise<Response> {
  const target = url(`/api/admin/polls/${pollId}/options`);
  return handlePollsRequest(new Request(target, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ options })
  }), target, env, ACTOR);
}

function listRequest(query = '?pageSize=100'): Promise<Response> {
  const target = url(`/api/admin/polls${query}`);
  return handlePollsRequest(new Request(target), target, env, ACTOR);
}

beforeAll(async () => {
  await applySchema();
});

describe('admin poll options', () => {
  it('replaces the option set of a pending choice poll and writes an audit entry', async () => {
    const pollId = await seedPoll({ title: 'Editable options poll', pollType: 2, status: 4 });
    await seedOptions(pollId, [
      { position: 1, label: 'Old one' },
      { position: 2, label: 'Old two' },
      { position: 3, label: 'Old three' }
    ]);

    const response = await optionsRequest(pollId, [
      { position: 1, label: 'New one' },
      { position: 2, label: 'New two' }
    ]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      pollId,
      options: [
        { position: 1, label: 'New one' },
        { position: 2, label: 'New two' }
      ]
    });

    const stored = await env.DB.prepare(
      'SELECT position, label FROM poll_options WHERE poll_id = ? ORDER BY position ASC'
    ).bind(pollId).all<{ position: number; label: string }>();
    expect(stored.results).toEqual([
      { position: 1, label: 'New one' },
      { position: 2, label: 'New two' }
    ]);

    const audit = await env.DB.prepare(
      "SELECT action, actor_username, details FROM admin_audit_log WHERE action = 'poll.options' AND target_id = ?"
    ).bind(String(pollId)).first<{ action: string; actor_username: string; details: string }>();
    expect(audit?.action).toBe('poll.options');
    expect(audit?.actor_username).toBe('admin');
    const details = JSON.parse(audit?.details ?? '{}');
    expect(details.options).toHaveLength(2);
    expect(details.previous).toHaveLength(3);
  });

  it('rejects an invalid option set', async () => {
    const pollId = await seedPoll({ title: 'Validation options poll', pollType: 3, status: 4 });
    await seedOptions(pollId, [
      { position: 1, label: 'A' },
      { position: 2, label: 'B' }
    ]);

    // Too few, too many, duplicates, and an over-long label.
    expect((await optionsRequest(pollId, [{ position: 1, label: 'Only one' }])).status).toBe(400);
    expect((await optionsRequest(pollId, Array.from({ length: 8 }, (_, index) => ({
      position: index + 1, label: `Option ${index + 1}`
    })))).status).toBe(400);
    expect((await optionsRequest(pollId, [
      { position: 1, label: 'Same' }, { position: 2, label: 'same' }
    ])).status).toBe(400);
    expect((await optionsRequest(pollId, [
      { position: 1, label: 'x'.repeat(81) }, { position: 2, label: 'Other' }
    ])).status).toBe(400);

    // The stored set is untouched by a rejected request.
    const stored = await env.DB.prepare(
      'SELECT COUNT(*) AS total FROM poll_options WHERE poll_id = ?'
    ).bind(pollId).first<{ total: number }>();
    expect(stored?.total).toBe(2);
  });

  it('only allows editing while the poll is pending', async () => {
    const openPoll = await seedPoll({ title: 'Open options poll', pollType: 2, status: 1 });
    await seedOptions(openPoll, [
      { position: 1, label: 'A' },
      { position: 2, label: 'B' }
    ]);
    const refused = await optionsRequest(openPoll, [
      { position: 1, label: 'Changed' },
      { position: 2, label: 'B' }
    ]);
    expect(refused.status).toBe(409);

    const verdictPoll = await seedPoll({ title: 'Verdict options poll', status: 4 });
    expect((await optionsRequest(verdictPoll, [
      { position: 1, label: 'A' }, { position: 2, label: 'B' }
    ])).status).toBe(409);

    expect((await optionsRequest(999_999, [
      { position: 1, label: 'A' }, { position: 2, label: 'B' }
    ])).status).toBe(404);
  });
});

describe('admin poll listing', () => {
  it('reports the poll type and the option counts', async () => {
    const pollId = await seedPoll({ title: 'Listed choice poll', pollType: 2, durationSeconds: 86_400 });
    const ids = await seedOptions(pollId, [
      { position: 1, label: 'First' },
      { position: 2, label: 'Second' }
    ]);
    const voteId = await env.DB.prepare(
      'INSERT INTO votes (poll_id, voter_token_hash, option, created_at) VALUES (?, ?, NULL, unixepoch())'
    ).bind(pollId, 'f'.repeat(64)).run();
    await env.DB.prepare('INSERT INTO vote_selections (vote_id, option_id) VALUES (?, ?)')
      .bind(Number(voteId.meta.last_row_id), ids.get(1)!).run();

    const response = await listRequest();
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    const row = body.polls.find((entry: any) => entry.id === pollId);
    expect(row.pollType).toBe('single_choice');
    expect(row.durationSeconds).toBe(86_400);
    expect(row.ballots).toBe(1);
    expect(row.options).toEqual([
      { id: ids.get(1), label: 'First', position: 1, virtual: false, count: 1 },
      { id: ids.get(2), label: 'Second', position: 2, virtual: false, count: 0 }
    ]);
  });

  it('shows the three virtual options of a verdict poll', async () => {
    const pollId = await seedPoll({ title: 'Listed verdict poll' });
    await env.DB.prepare(
      'INSERT INTO votes (poll_id, voter_token_hash, option, created_at) VALUES (?, ?, 1, unixepoch())'
    ).bind(pollId, 'e'.repeat(64)).run();

    const response = await listRequest();
    const body = await response.json() as any;
    const row = body.polls.find((entry: any) => entry.id === pollId);
    expect(row.pollType).toBe('verdict');
    expect(row.ballots).toBe(1);
    expect(row.counts).toEqual({ approve: 1, neutral: 0, oppose: 0 });
    expect(row.options).toEqual([
      { id: 1, label: 'approve', position: 1, virtual: true, count: 1 },
      { id: 3, label: 'neutral', position: 2, virtual: true, count: 0 },
      { id: 2, label: 'oppose', position: 3, virtual: true, count: 0 }
    ]);
  });
});
