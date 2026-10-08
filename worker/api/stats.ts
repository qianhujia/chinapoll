export type VoteOption = 'approve' | 'oppose' | 'neutral';

export interface StatsResponse {
  issueId: number;
  counts: Record<VoteOption, number>;
  voted: boolean;
}

export async function handleStatsRequest(request: Request, url: URL, env: any): Promise<Response> {
  const issueId = Number(url.pathname.split('/').pop() ?? '0');

  const counts: Record<VoteOption, number> = { approve: 0, oppose: 0, neutral: 0 };

  const result: any = await env.DB.prepare(
    `SELECT option, COUNT(*) as count FROM votes WHERE issue_id = ? GROUP BY option`
  ).bind(issueId).all();

  for (const row of result.results ?? []) {
    const option = String(row.option) as VoteOption;
    if (option in counts) {
      counts[option] = Number(row.count ?? 0);
    }
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
