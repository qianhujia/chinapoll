import type { HandlerEnv } from '../index';
import {
  getPollModeLabel,
  getPollStatusLabel,
  PollMode,
  PollStatus,
  VoteOption,
  toIsoDate
} from '../enums.js';

const MAX_PAGE_SIZE = 100;
const MAX_QUERY_LENGTH = 100;
// Window and page cap for the recently closed poll listing used by the snapshot
// publisher. Polls are purged 30 days after close, so slightly more than 30 days
// keeps a missed publish run inside the window.
const RECENT_CLOSED_DAYS = 35;
const RECENT_CLOSED_MAX_DAYS = 365;
const RECENT_CLOSED_LIMIT = 500;

interface PollRow {
  id: number;
  title: string;
  description: string | null;
  mode: PollMode;
  start_at: number | null;
  end_at: number | null;
  status: PollStatus;
  approve: number;
  neutral: number;
  oppose: number;
}

// Builds the LIKE parameters and the WHERE fragment for a title/description
// search. The column prefix keeps the fragment valid inside the joined query.
function buildSearch(query: string, prefix = ''): { clause: string; pattern: string | null } {
  if (!query) return { clause: '', pattern: null };
  const pattern = `%${query.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
  return {
    clause: ` AND (${prefix}title LIKE ? ESCAPE '\\' OR ${prefix}description LIKE ? ESCAPE '\\')`,
    pattern
  };
}

export async function handlePollsRequest(request: Request, url: URL, env: HandlerEnv): Promise<Response> {
  if (request.method !== 'GET') {
    return Response.json({ message: 'method not allowed' }, { status: 405 });
  }

  // Recently closed polls are listed for the snapshot publisher, so a poll that
  // closed since the last publish run still has its final chain copied out.
  if (url.pathname === '/api/polls/recent-closed') {
    return listRecentlyClosed(url, env);
  }

  const pollIdText = url.pathname.slice('/api/polls/'.length);
  if (pollIdText) {
    return getPoll(pollIdText, env);
  }

  const page = Number(url.searchParams.get('page') ?? '1');
  const pageSize = Number(url.searchParams.get('pageSize') ?? '15');
  if (!Number.isSafeInteger(page) || page < 1
    || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    return Response.json({ message: 'invalid pagination parameters' }, { status: 400 });
  }

  const query = (url.searchParams.get('q') ?? '').trim().slice(0, MAX_QUERY_LENGTH);
  const search = buildSearch(query);
  const searchBinds = search.pattern ? [search.pattern, search.pattern] : [];

  const countResult = await env.DB.prepare(
    `SELECT COUNT(*) AS total
     FROM polls
     WHERE status = ? AND mode IN (?, ?)${search.clause}`
  ).bind(
    PollStatus.Open, PollMode.Deadline, PollMode.Evergreen,
    ...searchBinds
  ).first<{ total: number }>();

  const allPollsResult = await env.DB.prepare(
    'SELECT COUNT(*) AS total FROM polls WHERE mode IN (?, ?)'
  ).bind(PollMode.Deadline, PollMode.Evergreen).first<{ total: number }>();

  // The site-wide vote total is read from the latest snapshot per poll rather
  // than counting every vote on every request.
  const voteTotalResult = await env.DB.prepare(
    `SELECT COALESCE(SUM(s.approve + s.oppose + s.neutral), 0) AS total
     FROM stats_snapshots s
     JOIN (SELECT poll_id, MAX(ts_hour) AS ts_hour FROM stats_snapshots GROUP BY poll_id) latest
       ON latest.poll_id = s.poll_id AND latest.ts_hour = s.ts_hour`
  ).first<{ total: number }>();

  const total = Number(countResult?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages);
  const offset = (currentPage - 1) * pageSize;
// Select the page of poll ids first, then aggregate only those rows, so the
  // cost does not grow with the total number of votes.
  const result = await env.DB.prepare(
    `WITH page AS (
       SELECT id FROM polls
       WHERE status = ? AND mode IN (?, ?)${search.clause}
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
     )
     SELECT i.id, i.title, i.description, i.mode, i.start_at, i.end_at, i.status,
       COALESCE(SUM(CASE WHEN v.option = ? THEN 1 ELSE 0 END), 0) AS approve,
       COALESCE(SUM(CASE WHEN v.option = ? THEN 1 ELSE 0 END), 0) AS neutral,
       COALESCE(SUM(CASE WHEN v.option = ? THEN 1 ELSE 0 END), 0) AS oppose
     FROM page
     JOIN polls i ON i.id = page.id
     LEFT JOIN votes v ON v.poll_id = i.id
     GROUP BY i.id
     ORDER BY i.created_at DESC, i.id DESC`
  ).bind(
    PollStatus.Open, PollMode.Deadline, PollMode.Evergreen,
    ...searchBinds,
    pageSize, offset,
    VoteOption.Approve, VoteOption.Neutral, VoteOption.Oppose
  ).all<PollRow>();

  // Vote totals below the threshold are withheld so a small sample cannot reveal
  // how an individual voted.
  const threshold = Number(env.min_votes_to_display ?? 0);
  const polls = (result.results ?? []).map((row) => {
    const counts = {
      approve: Number(row.approve),
      neutral: Number(row.neutral),
      oppose: Number(row.oppose)
    };
    const voteTotal = counts.approve + counts.neutral + counts.oppose;
    const hidden = threshold > 0 && voteTotal < threshold;
    return {
      poll: {
        id: row.id,
        title: row.title,
        description: row.description,
        mode: getPollModeLabel(row.mode),
        start_at: toIsoDate(row.start_at),
        end_at: toIsoDate(row.end_at),
        status: getPollStatusLabel(row.status)
      },
      stats: {
        pollId: row.id,
        counts: hidden ? null : counts,
        hidden,
        threshold,
        voted: false
      }
    };
  });

  return Response.json({
    polls,
    page: currentPage,
    pageSize,
    total,
    query,
    totalPolls: Number(allPollsResult?.total ?? 0),
    totalVotes: Number(voteTotalResult?.total ?? 0)
  }, {
    headers: { 'cache-control': 'no-store' }
  });
}

// Lists polls that closed within the last `days` days so the snapshot publisher
// can fetch their final chain. Only the identity, status, and close time are
// returned; the chains themselves are read from /api/snapshots/:id.
async function listRecentlyClosed(url: URL, env: HandlerEnv): Promise<Response> {
  const rawDays = url.searchParams.get('days');
  const days = rawDays === null ? RECENT_CLOSED_DAYS : Number(rawDays);
  if (!Number.isSafeInteger(days) || days < 1 || days > RECENT_CLOSED_MAX_DAYS) {
    return Response.json({ message: 'invalid days parameter' }, { status: 400 });
  }

  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const result = await env.DB.prepare(
    `SELECT id, status, closed_at FROM polls
     WHERE status IN (?, ?) AND closed_at IS NOT NULL AND closed_at >= ?
     ORDER BY closed_at DESC, id DESC LIMIT ?`
  ).bind(PollStatus.Closed, PollStatus.Archived, since, RECENT_CLOSED_LIMIT)
    .all<{ id: number; status: PollStatus; closed_at: number }>();

  const polls = (result.results ?? []).map((row) => ({
    id: Number(row.id),
    status: getPollStatusLabel(row.status),
    closedAt: toIsoDate(row.closed_at)
  }));

  return Response.json({ polls, total: polls.length }, {
    headers: { 'cache-control': 'no-store' }
  });
}

async function getPoll(pollIdText: string, env: HandlerEnv): Promise<Response> {
  if (!/^[1-9]\d*$/.test(pollIdText)) {
    return Response.json({ message: 'invalid poll ID' }, { status: 400 });
  }

  const pollId = Number(pollIdText);
  if (!Number.isSafeInteger(pollId)) {
    return Response.json({ message: 'invalid poll ID' }, { status: 400 });
  }

  const poll = await env.DB.prepare(
    `SELECT id, title, description, mode, start_at, end_at, status
     FROM polls
     WHERE id = ? AND mode IN (?, ?) AND status IN (?, ?, ?)`
  ).bind(
    pollId,
    PollMode.Deadline, PollMode.Evergreen,
    PollStatus.Open, PollStatus.Closed, PollStatus.Archived
  ).first<{
    id: number;
    title: string;
    description: string | null;
    mode: PollMode;
    start_at: number | null;
    end_at: number | null;
    status: PollStatus;
  }>();

  if (!poll) {
    return Response.json({ message: 'poll not found' }, { status: 404 });
  }

  return Response.json({ poll: {
    ...poll,
    mode: getPollModeLabel(poll.mode),
    start_at: toIsoDate(poll.start_at),
    end_at: toIsoDate(poll.end_at),
    status: getPollStatusLabel(poll.status)
  } }, {
    headers: { 'cache-control': 'no-store' }
  });
}