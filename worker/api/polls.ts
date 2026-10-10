import {
  getPollModeLabel,
  getPollStatusLabel,
  PollMode,
  PollStatus,
  VoteOption,
  toIsoDate
} from '../enums.js';

const MAX_PAGE_SIZE = 100;

interface PollsEnv {
  DB: D1Database;
}

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

export async function handlePollsRequest(request: Request, url: URL, env: PollsEnv): Promise<Response> {
  if (request.method !== 'GET') {
    return Response.json({ message: 'method not allowed' }, { status: 405 });
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

  const countResult = await env.DB.prepare(
    `SELECT COUNT(*) AS total
     FROM polls
     WHERE status = ? AND title IS NOT NULL AND TRIM(title) != ''
       AND mode IN (?, ?)`
  ).bind(PollStatus.Open, PollMode.Deadline, PollMode.Evergreen).first<{ total: number }>();

  const allPollsResult = await env.DB.prepare(
    `SELECT COUNT(*) AS total
     FROM polls
     WHERE title IS NOT NULL AND TRIM(title) != ''
       AND mode IN (?, ?)`
  ).bind(PollMode.Deadline, PollMode.Evergreen).first<{ total: number }>();

  const voteTotalResult = await env.DB.prepare(
    'SELECT COUNT(*) AS total FROM votes'
  ).first<{ total: number }>();

  const total = Number(countResult?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages);
  const offset = (currentPage - 1) * pageSize;
  const result = await env.DB.prepare(
    `SELECT i.id, i.title, i.description, i.mode, i.start_at, i.end_at, i.status,
       COALESCE(SUM(CASE WHEN v.option = ? THEN 1 ELSE 0 END), 0) AS approve,
       COALESCE(SUM(CASE WHEN v.option = ? THEN 1 ELSE 0 END), 0) AS neutral,
       COALESCE(SUM(CASE WHEN v.option = ? THEN 1 ELSE 0 END), 0) AS oppose
     FROM polls i
     LEFT JOIN votes v ON v.poll_id = i.id
     WHERE i.status = ? AND i.title IS NOT NULL AND TRIM(i.title) != ''
       AND i.mode IN (?, ?)
     GROUP BY i.id
     ORDER BY i.created_at DESC, i.id DESC
     LIMIT ? OFFSET ?`
  ).bind(
    VoteOption.Approve, VoteOption.Neutral, VoteOption.Oppose,
    PollStatus.Open, PollMode.Deadline, PollMode.Evergreen,
    pageSize, offset
  ).all<PollRow>();

  const polls = (result.results ?? []).map((row) => ({
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
      counts: {
        approve: Number(row.approve),
        neutral: Number(row.neutral),
        oppose: Number(row.oppose)
      },
      voted: false
    }
  }));

  return Response.json({
    polls,
    page: currentPage,
    pageSize,
    total,
    totalPolls: Number(allPollsResult?.total ?? 0),
    totalVotes: Number(voteTotalResult?.total ?? 0)
  }, {
    headers: { 'cache-control': 'no-store' }
  });
}

async function getPoll(pollIdText: string, env: PollsEnv): Promise<Response> {
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
     WHERE id = ? AND title IS NOT NULL AND TRIM(title) != ''
       AND mode IN (?, ?)
       AND status IN (?, ?, ?)`
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
