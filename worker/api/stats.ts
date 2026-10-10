import { getVoteOptionLabel, VoteOption as VoteOptionCode, type VoteOptionLabel } from '../enums.js';

export type VoteOption = VoteOptionLabel;

export interface StatsResponse {
  issueId: number;
  counts: Record<VoteOption, number>;
  voted: boolean;
}

export async function handleStatsRequest(request: Request, url: URL, env: any): Promise<Response> {
  const issueId = Number(url.pathname.split('/').pop() ?? '0');

  const counts: Record<VoteOption, number> = { approve: 0, oppose: 0, neutral: 0 };

  const result: { results?: Array<{ option: VoteOptionCode; count: number }> } = await env.DB.prepare(
    `SELECT option, COUNT(*) as count FROM votes WHERE issue_id = ? GROUP BY option`
  ).bind(issueId).all();

  for (const row of result.results ?? []) {
    counts[getVoteOptionLabel(row.option)] = Number(row.count ?? 0);
  }

  return new Response(JSON.stringify({
    issueId,
    counts,
    voted: false
  } satisfies StatsResponse), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    }
  });
}
