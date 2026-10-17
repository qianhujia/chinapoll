// Public vote totals for one poll.
//
// Every poll type answers with the same results shape from the shared engine:
// the ballot total and one entry per option, or `options: null` below the
// display threshold. A verdict poll keeps its legacy `counts` object so existing
// clients keep reading it the same way.

import type { HandlerEnv } from '../index';
import { PollType } from '../enums.js';
import {
  countPollBallots,
  getPollOptions,
  isChoicePollType,
  legacyVerdictCounts,
  toPublicResults,
  type PublicResults
} from '../services/options.js';

export interface StatsResponse extends PublicResults {
  pollId: number;
  /** Legacy verdict counts; null for a choice poll or while the results are hidden. */
  counts: { approve: number; neutral: number; oppose: number } | null;
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

  const poll = await env.DB.prepare('SELECT id, poll_type FROM polls WHERE id = ?')
    .bind(pollId).first<{ id: number; poll_type: number }>();
  const pollType = Number(poll?.poll_type ?? PollType.Verdict);

  const options = await getPollOptions(env, { id: pollId, poll_type: pollType });
  const tally = await countPollBallots(env, { id: pollId, poll_type: pollType });
  const threshold = Number(env.min_votes_to_display ?? 0);
  const results = toPublicResults({ poll_type: pollType }, options, tally, threshold);

  return new Response(JSON.stringify({
    pollId,
    ...results,
    counts: isChoicePollType(pollType) || results.hidden ? null : legacyVerdictCounts(options, tally),
    voted: false
  } satisfies StatsResponse), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    }
  });
}
