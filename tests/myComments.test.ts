import { describe, expect, it, vi } from 'vitest';
import { getUserComments } from '../src/lib/session';

// The comment list comes back from the server in a fixed order, but the remembered
// ids are in posting order, so the dashboard reverses them to show the newest first.
describe('getUserComments', () => {
  it('orders the comments by the remembered posting order, newest first', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL) => {
      requested.push(String(input));
      // The server answers in its own fixed order (here: the oldest first).
      return {
        ok: true,
        status: 200,
        json: async () => ({
          comments: [
            { id: 'aaaaaaaaaaaaaaaa', pollId: 1, pollTitle: 'One', comment: 'oldest', createdAt: '2026-10-17T00:00:00.000Z' },
            { id: 'bbbbbbbbbbbbbbbb', pollId: 2, pollTitle: 'Two', comment: 'newest', createdAt: '2026-10-17T00:00:00.000Z' }
          ]
        })
      } as unknown as Response;
    });

    const comments = await getUserComments(['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb']);

    expect(comments.map((comment) => comment.comment)).toEqual(['newest', 'oldest']);
    expect(requested[0]).toContain('ids=aaaaaaaaaaaaaaaa%2Cbbbbbbbbbbbbbbbb');
    vi.unstubAllGlobals();
  });

  it('drops ids the server did not confirm and skips the request when nothing is remembered', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ comments: [] })
    } as unknown as Response)));

    // A comment the server does not return (deleted, or never owned) is left out.
    expect(await getUserComments(['aaaaaaaaaaaaaaaa'])).toEqual([]);
    // Nothing remembered means no request at all.
    expect(await getUserComments([])).toEqual([]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
