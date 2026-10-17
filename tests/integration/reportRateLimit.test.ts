import { beforeAll, describe, expect, it } from 'vitest';
import { applySchema, reportRequest, seedPoll } from './helpers';

beforeAll(async () => {
  await applySchema();
});

describe('report rate limit', () => {
  it('limits anonymous reports per network using the default 3/d quota', async () => {
    const pollId = await seedPoll({ title: 'Report rate limit poll' });

    expect((await reportRequest(pollId, 'spam')).status).toBe(201);
    expect((await reportRequest(pollId, 'spam')).status).toBe(201);
    expect((await reportRequest(pollId, 'spam')).status).toBe(201);

    const limited = await reportRequest(pollId, 'spam');
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ ok: false, message: 'report rate limit reached' });
  });
});
