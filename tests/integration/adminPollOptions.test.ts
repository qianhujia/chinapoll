import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { AdminActor } from '../../admin/auth';
import { handlePollsRequest } from '../../admin/api/polls';
import { getPollOptions } from '../../worker/services/options';
import { applySchema, insertBallot, seedOptions, seedPoll, seedVerdictTemplatePoll } from './helpers';

// The admin Worker is deployed separately and has no test harness of its own, so
// its handlers are exercised directly against the shared D1 binding.
const ACTOR: AdminActor = { id: 1, username: 'admin', role: 'admin' };

function url(path: string): URL {
  return new URL(`https://admin.example.com${path}`);
}

function optionUpdateRequest(pollId: number, body: Record<string, unknown>): Promise<Response> {
  const target = url(`/api/admin/polls/${pollId}/options`);
  return handlePollsRequest(new Request(target, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }), target, env, ACTOR);
}

function optionsRequest(pollId: number, options: Array<{ position: number; label: string }>): Promise<Response> {
  return optionUpdateRequest(pollId, { options });
}

function listRequest(query = '?pageSize=100'): Promise<Response> {
  const target = url(`/api/admin/polls${query}`);
  return handlePollsRequest(new Request(target), target, env, ACTOR);
}

// The stored labels of a poll, in position order.
async function storedLabels(pollId: number): Promise<string[]> {
  const options = await getPollOptions(env, { id: pollId, poll_type: 2 });
  return options.map((option) => option.label);
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

  it('only allows editing while the poll is pending and before any ballot', async () => {
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

    // A pending poll whose options are frozen by a ballot cannot be edited.
    const votedPoll = await seedPoll({ title: 'Voted options poll', pollType: 2, status: 4 });
    const votedOptions = await seedOptions(votedPoll, [
      { position: 1, label: 'A' },
      { position: 2, label: 'B' }
    ]);
    await insertBallot(votedPoll, 'c'.repeat(64), [votedOptions.get(1)!]);
    const frozen = await optionsRequest(votedPoll, [
      { position: 1, label: 'Changed' },
      { position: 2, label: 'B' }
    ]);
    expect(frozen.status).toBe(409);
    expect(await frozen.json()).toMatchObject({ message: expect.stringContaining('already has ballots') });

    // A verdict poll is its own type with its own rows, so its labels can be
    // rewritten and trimmed like any other poll's.
    const { pollId: templatePoll } = await seedVerdictTemplatePoll({
      title: 'Verdict options poll',
      status: 4
    });
    const edited = await optionsRequest(templatePoll, [
      { position: 1, label: 'Yes' },
      { position: 2, label: 'No' }
    ]);
    expect(edited.status).toBe(200);
    expect(await storedLabels(templatePoll)).toEqual(['Yes', 'No']);

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
    await insertBallot(pollId, 'f'.repeat(64), [ids.get(1)!]);

    const response = await listRequest();
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    const row = body.polls.find((entry: any) => entry.id === pollId);
    expect(row.pollType).toBe('single_choice');
    expect(row.durationSeconds).toBe(86_400);
    expect(row.ballots).toBe(1);
    // There is no separate counts object; each option carries its own count.
    expect(row.counts).toBeUndefined();
    expect(row.options).toEqual([
      { id: ids.get(1), label: 'First', position: 1, count: 1 },
      { id: ids.get(2), label: 'Second', position: 2, count: 0 }
    ]);
  });

  it('shows the option rows of a verdict poll with their counts', async () => {
    const { pollId, options } = await seedVerdictTemplatePoll({ title: 'Listed verdict poll' });
    await insertBallot(pollId, 'e'.repeat(64), [options.get(1)!]);

    const response = await listRequest();
    const body = await response.json() as any;
    const row = body.polls.find((entry: any) => entry.id === pollId);
    expect(row.pollType).toBe('verdict');
    expect(row.ballots).toBe(1);
    expect(row.options.map((option: any) => [option.label, option.position, option.count])).toEqual([
      ['Approve', 1, 1],
      ['Neutral', 2, 0],
      ['Oppose', 3, 0]
    ]);
  });
});
