import { describe, expect, it, vi } from 'vitest';
import { getUserComments } from '../src/lib/session';

// The server returns one page at a time with a `hasMore` flag; the client keeps
// whatever order the server sends.
describe('getUserComments', () => {
  it('requests the given page and returns the server order with its pagination flags', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL) => {
      requested.push(String(input));
      // The server answers one page in its own order, newest first.
      return {
        ok: true,
        status: 200,
        json: async () => ({
          comments: [
            { id: 'bbbbbbbbbbbbbbbb', pollId: 2, pollTitle: 'Two', comment: 'newest', createdAt: '2026-10-17T00:00:00.000Z' },
            { id: 'aaaaaaaaaaaaaaaa', pollId: 1, pollTitle: 'One', comment: 'oldest', createdAt: '2026-10-17T00:00:00.000Z' }
          ],
          page: 2,
          hasMore: true
        })
      } as unknown as Response;
    });

    const result = await getUserComments(2);

    expect(result.page).toBe(2);
    expect(result.hasMore).toBe(true);
    expect(result.comments.map((comment) => comment.comment)).toEqual(['newest', 'oldest']);
    expect(requested[0]).toContain('/api/user/comments?page=2');
    vi.unstubAllGlobals();
  });

  it('defaults to page 1 and an empty list', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      requested.push(String(input));
      return {
        ok: true,
        status: 200,
        json: async () => ({ comments: [], page: 1, hasMore: false })
      } as unknown as Response;
    }));

    expect(await getUserComments()).toEqual({ comments: [], page: 1, hasMore: false });
    expect(requested[0]).toContain('/api/user/comments?page=1');
    vi.unstubAllGlobals();
  });
});
