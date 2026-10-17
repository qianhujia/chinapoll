import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applySchema, reportRequest, seedPoll } from './helpers';

beforeAll(async () => {
  await applySchema();
  // Raise the report rate limit and disable both auto-hide rules. The settings
  // cache loads on the first request, so these values apply for the whole file.
  await env.DB.batch([
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('report_rate_limit', '1000/d')"),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('report_auto_hide_threshold', '0')"),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('report_auto_hide_priority_threshold', '0')")
  ]);
});

describe('report auto-hide disabled', () => {
  it('keeps a poll open when both thresholds are zero', async () => {
    const pollId = await seedPoll({ title: 'Disabled thresholds poll' });

    // Six high-priority reports would trip both default rules; with the rules
    // disabled the poll must stay open.
    for (let index = 0; index < 6; index += 1) {
      expect((await reportRequest(pollId, 'harassment')).status).toBe(201);
    }

    const poll = await env.DB.prepare('SELECT status FROM polls WHERE id = ?')
      .bind(pollId).first<{ status: number }>();
    expect(poll?.status).toBe(1);
  });
});
