// Public vote totals for one poll.
//
// Every poll type answers with the same results shape from the shared engine:
// the ballot total and one entry per option, or `options: null` below the
// display threshold. Each option carries its own `count`, so there is no separate
// counts object.

import type { HandlerEnv } from '../index';
import { PollType } from '../enums.js';
import {
  countPollBallots,
  getPollOptions,
  toPublicResults,
  type PublicResults
} from '../services/options.js';
import { apiError } from '../../shared/http';

export interface StatsResponse extends PublicResults {
  pollId: number;
  voted: boolean;
}

export async function handleStatsRequest(request: Request, url: URL, env: HandlerEnv): Promise<Response> {
  if (request.method !== 'GET') {
    return apiError('METHOD_NOT_ALLOWED', 405);
  }

  // Same validation as getPoll in polls.ts.
  const pollIdText = url.pathname.split('/').pop() ?? '';
  if (!/^[1-9]\d*$/.test(pollIdText)) {
    return apiError('INVALID_POLL_ID', 400);
  }
  const pollId = Number(pollIdText);
  if (!Number.isSafeInteger(pollId)) {
    return apiError('INVALID_POLL_ID', 400);
  }

  const poll = await env.DB.prepare('SELECT id, poll_type FROM polls WHERE id = ?')
    .bind(pollId).first<{ id: number; poll_type: number }>();
  const pollType = Number(poll?.poll_type ?? PollType.SingleChoice);

  const options = await getPollOptions(env, { id: pollId, poll_type: pollType });
  const tally = await countPollBallots(env, { id: pollId, poll_type: pollType });
  const threshold = Number(env.min_votes_to_display ?? 0);
  const results = toPublicResults({ poll_type: pollType }, options, tally, threshold);

  return new Response(JSON.stringify({
    pollId,
    ...results,
    voted: false
  } satisfies StatsResponse), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    }
  });
}
