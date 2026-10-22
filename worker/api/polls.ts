import type { HandlerEnv } from '../index';
import {
  getPollModeLabel,
  getPollStatusLabel,
  PollMode,
  PollStatus,
  PollType,
  toIsoDate
} from '../enums.js';
import {
  countBallots,
  getOptionsForPolls,
  pollTypeLabel,
  toPublicResults,
  type PollOption
} from '../services/options.js';
import { loadViewCounts, publicViews } from './views';
import { TOPIC_SLUG_PATTERN } from '../../shared/categories';

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
  poll_type: number;
  start_at: number | null;
  end_at: number | null;
  status: PollStatus;
  ballots: number;
  topic_slug: string | null;
  topic_name: string | null;
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

  // An optional topic filter. A slug that does not name an enabled topic
  // matches nothing, so the listing is simply empty.
  const topicSlug = (url.searchParams.get('topic') ?? '').trim();
  if (topicSlug && !TOPIC_SLUG_PATTERN.test(topicSlug)) {
    return Response.json({ message: 'invalid topic' }, { status: 400 });
  }
  const topicClause = topicSlug
    ? ' AND topic_id = (SELECT id FROM topics WHERE slug = ? AND enabled = 1)'
    : '';
  const topicBinds = topicSlug ? [topicSlug] : [];

  const countResult = await env.DB.prepare(
    `SELECT COUNT(*) AS total
     FROM polls
     WHERE status = ? AND mode IN (?, ?)${search.clause}${topicClause}`
  ).bind(
    PollStatus.Open, PollMode.Deadline, PollMode.Evergreen,
    ...searchBinds, ...topicBinds
  ).first<{ total: number }>();

  const allPollsResult = await env.DB.prepare(
    'SELECT COUNT(*) AS total FROM polls WHERE mode IN (?, ?)'
  ).bind(PollMode.Deadline, PollMode.Evergreen).first<{ total: number }>();

  // The site-wide vote total is read from the latest snapshot per poll rather
  // than counting every vote on every request.
  const voteTotalResult = await env.DB.prepare(
    `SELECT COALESCE(SUM(s.ballots), 0) AS total
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
       WHERE status = ? AND mode IN (?, ?)${search.clause}${topicClause}
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
     )
     SELECT i.id, i.title, i.description, i.mode, i.poll_type, i.start_at, i.end_at, i.status,
       t.slug AS topic_slug, t.name AS topic_name,
       (SELECT COUNT(*) FROM votes b WHERE b.poll_id = i.id) AS ballots
     FROM page
     JOIN polls i ON i.id = page.id
     LEFT JOIN topics t ON t.id = i.topic_id
     ORDER BY i.created_at DESC, i.id DESC`
  ).bind(
    PollStatus.Open, PollMode.Deadline, PollMode.Evergreen,
    ...searchBinds, ...topicBinds,
    pageSize, offset
  ).all<PollRow>();

  // Vote totals below the threshold are withheld so a small sample cannot reveal
  // how an individual voted.
  const threshold = Number(env.min_votes_to_display ?? 0);
  const viewsThreshold = Number(env.min_views_to_display ?? 0);
  const pageRows = (result.results ?? []).map((row) => ({
    id: Number(row.id),
    poll_type: Number(row.poll_type ?? PollType.SingleChoice)
  }));
  const viewCounts = await loadViewCounts(env.DB, pageRows.map((row) => row.id));
  // The options and the tally of every poll on this page are read with a fixed
  // number of aggregate queries (paginate, then aggregate), so the cost does not
  // grow with the number of ballots.
  const optionsByPoll = await getOptionsForPolls(env, pageRows);
  const tallies = await countBallots(env, pageRows);

  const polls = (result.results ?? []).map((row) => {
    const pollId = Number(row.id);
    const pollType = Number(row.poll_type ?? PollType.SingleChoice);
    const options = optionsByPoll.get(pollId) ?? [];
    const tally = tallies.get(pollId) ?? { ballots: 0, counts: new Map<number, number>() };
    const results = toPublicResults({ poll_type: pollType }, options, tally, threshold);
    return {
      poll: {
        id: row.id,
        title: row.title,
        description: row.description,
        mode: getPollModeLabel(row.mode),
        pollType: results.pollType,
        options: options.map(publicOption),
        start_at: toIsoDate(row.start_at),
        end_at: toIsoDate(row.end_at),
        status: getPollStatusLabel(row.status),
        topic: row.topic_slug && row.topic_name
          ? { slug: row.topic_slug, name: row.topic_name }
          : null
      },
      stats: {
        pollId: row.id,
        ...results,
        voted: false
      },
      views: publicViews(viewCounts.get(pollId), viewsThreshold)
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

// The public option shape: identity, order, and the submitter's label.
function publicOption(option: PollOption): { id: number; position: number; label: string } {
  return {
    id: option.id,
    position: option.position,
    label: option.label
  };
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
    `SELECT p.id, p.title, p.description, p.mode, p.poll_type, p.start_at, p.end_at,
            p.duration_seconds, p.status, t.slug AS topic_slug, t.name AS topic_name
     FROM polls p
     LEFT JOIN topics t ON t.id = p.topic_id
     WHERE p.id = ? AND p.mode IN (?, ?) AND p.status IN (?, ?, ?)`
  ).bind(
    pollId,
    PollMode.Deadline, PollMode.Evergreen,
    PollStatus.Open, PollStatus.Closed, PollStatus.Archived
  ).first<{
    id: number;
    title: string;
    description: string | null;
    mode: PollMode;
    poll_type: number;
    start_at: number | null;
    end_at: number | null;
    duration_seconds: number | null;
    status: PollStatus;
    topic_slug: string | null;
    topic_name: string | null;
  }>();

  if (!poll) {
    return Response.json({ message: 'poll not found' }, { status: 404 });
  }

  const viewCounts = await loadViewCounts(env.DB, [pollId]);
  const views = publicViews(viewCounts.get(pollId), Number(env.min_views_to_display ?? 0));

  // The options come from the shared engine, so every poll exposes its labeled
  // rows here.
  const options = await getOptionsForPolls(env, [{ id: pollId, poll_type: poll.poll_type }]);
  const pollOptions = options.get(pollId) ?? [];

  const { topic_slug: topicSlugValue, topic_name: topicNameValue, ...pollFields } = poll;

  return Response.json({ poll: {
    ...pollFields,
    topic: topicSlugValue && topicNameValue
      ? { slug: topicSlugValue, name: topicNameValue }
      : null,
    mode: getPollModeLabel(poll.mode),
    pollType: pollTypeLabel(Number(poll.poll_type ?? PollType.SingleChoice)),
    options: pollOptions.map(publicOption),
    start_at: toIsoDate(poll.start_at),
    end_at: toIsoDate(poll.end_at),
    status: getPollStatusLabel(poll.status)
  }, views }, {
    headers: { 'cache-control': 'no-store' }
  });
}