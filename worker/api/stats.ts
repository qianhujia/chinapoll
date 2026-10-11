import { getVoteOptionLabel, VoteOption as VoteOptionCode, type VoteOptionLabel } from '../enums.js';

export type VoteOption = VoteOptionLabel;

export interface StatsResponse {
  pollId: number;
  counts: Record<VoteOption, number> | null;
  hidden: boolean;
  threshold: number;
  voted: boolean;
}

export async function handleStatsRequest(request: Request, url: URL, env: any): Promise<Response> {
  if (request.method !== 'GET') {
    return Response.json({ message: 'method not allowed' }, { status: 405 });
  }

  // Same validation as getPoll in polls.ts.
  const pollIdText = url.pathname.split('/').pop() ?? '';
  if (!/^[1-9]\d*$/.test(pollIdText)) {
    return Response.json({ message: 'invalid poll ID' }, { status: 400 });
  }
  const pollId = Number(pollIdText);
  if (!Number.isSafeInteger(pollId)) {
    return Response.json({ message: 'invalid poll ID' }, { status: 400 });
  }

  const counts: Record<VoteOption, number> = { approve: 0, oppose: 0, neutral: 0 };

  const result: { results?: Array<{ option: VoteOptionCode; count: number }> } = await env.DB.prepare(
    `SELECT option, COUNT(*) as count FROM votes WHERE poll_id = ? GROUP BY option`
  ).bind(pollId).all();

  for (const row of result.results ?? []) {
    counts[getVoteOptionLabel(row.option)] = Number(row.count ?? 0);
  }

  const threshold = Number(env.min_votes_to_display ?? 0);
  const total = counts.approve + counts.oppose + counts.neutral;
  const hidden = threshold > 0 && total < threshold;

  return new Response(JSON.stringify({
    pollId,
    counts: hidden ? null : counts,
    hidden,
    threshold,
    voted: false
  } satisfies StatsResponse), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    }
  });
}
