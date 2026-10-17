import type { HandlerEnv } from '../index';
import { getVoteOptionLabel, PollType, VoteOption as VoteOptionCode, type PollTypeLabel, type VoteOptionLabel } from '../enums.js';
import { choiceCounts, isChoicePollType, pollTypeLabel, type ChoiceCounts } from '../services/pollType.js';

export type VoteOption = VoteOptionLabel;

export interface StatsResponse {
  pollId: number;
  pollType: PollTypeLabel;
  counts: Record<VoteOption, number> | ChoiceCounts | null;
  hidden: boolean;
  threshold: number;
  voted: boolean;
}

export async function handleStatsRequest(request: Request, url: URL, env: HandlerEnv): Promise<Response> {
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

  const poll = await env.DB.prepare('SELECT poll_type FROM polls WHERE id = ?')
    .bind(pollId).first<{ poll_type: number }>();
  const pollType = Number(poll?.poll_type ?? PollType.Verdict);
  const threshold = Number(env.min_votes_to_display ?? 0);

  const base = {
    pollId,
    threshold,
    voted: false
  };

  // A choice poll reports the ballot total and one entry per option. The
  // threshold applies to the number of ballots, so every option count below it
  // is withheld together.
  if (isChoicePollType(pollType)) {
    const ballotsRow = await env.DB.prepare(
      'SELECT COUNT(*) AS total FROM votes WHERE poll_id = ?'
    ).bind(pollId).first<{ total: number }>();
    const optionsResult = await env.DB.prepare(
      `SELECT o.id, o.label, o.position, COALESCE(COUNT(vs.vote_id), 0) AS count
       FROM poll_options o
       LEFT JOIN vote_selections vs ON vs.option_id = o.id
       WHERE o.poll_id = ?
       GROUP BY o.id
       ORDER BY o.position ASC`
    ).bind(pollId).all<{ id: number; label: string; position: number; count: number }>();

    const visible = choiceCounts(Number(ballotsRow?.total ?? 0), optionsResult.results ?? [], threshold);
    return json({
      ...base,
      pollType: pollTypeLabel(pollType),
      counts: visible.counts,
      hidden: visible.hidden
    } satisfies StatsResponse);
  }

  const counts: Record<VoteOption, number> = { approve: 0, oppose: 0, neutral: 0 };

  const result: { results?: Array<{ option: VoteOptionCode; count: number }> } = await env.DB.prepare(
    `SELECT option, COUNT(*) as count FROM votes WHERE poll_id = ? AND option IS NOT NULL GROUP BY option`
  ).bind(pollId).all();

  for (const row of result.results ?? []) {
    counts[getVoteOptionLabel(row.option)] = Number(row.count ?? 0);
  }

  const total = counts.approve + counts.oppose + counts.neutral;
  const hidden = threshold > 0 && total < threshold;

  return json({
    ...base,
    pollType: 'verdict',
    counts: hidden ? null : counts,
    hidden
  } satisfies StatsResponse);
}

function json(body: StatsResponse): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    }
  });
}
