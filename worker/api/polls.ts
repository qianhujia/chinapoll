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
import { loadPollNeighbors } from '../services/pollNav';
import { TOPIC_SLUG_PATTERN } from '../../shared/categories';
import { apiError } from '../../shared/http';

const MAX_PAGE_SIZE = 100;
const MAX_QUERY_LENGTH = 100;

interface PollRow {
  id: number;
  number: number;
  title: string;
  description: string | null;
  mode: PollMode;
  poll_type: number;
  start_at: number | null;
  end_at: number | null;
  status: PollStatus;
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
    return apiError('METHOD_NOT_ALLOWED', 405);
  }

  const pollIdText = url.pathname.slice('/api/polls/'.length);
  if (pollIdText) {
    return getPoll(pollIdText, env);
  }

  const page = Number(url.searchParams.get('page') ?? '1');
  const pageSize = Number(url.searchParams.get('pageSize') ?? '15');
  if (!Number.isSafeInteger(page) || page < 1
    || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    return apiError('INVALID_PAGINATION', 400);
  }

  const query = (url.searchParams.get('q') ?? '').trim().slice(0, MAX_QUERY_LENGTH);
  const search = buildSearch(query);
  const searchBinds = search.pattern ? [search.pattern, search.pattern] : [];

  // An optional topic filter. A slug that does not name an enabled topic
  // matches nothing, so the listing is simply empty.
  const topicSlug = (url.searchParams.get('topic') ?? '').trim();
  if (topicSlug && !TOPIC_SLUG_PATTERN.test(topicSlug)) {
    return apiError('INVALID_TOPIC', 400);
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

  // The site-wide total shown as the home page's `Polls` statistic. It counts
  // every open poll rather than this filter's matches, so the hero number never
  // changes with a search or a topic filter. Closed, archived, and pending polls
  // are left out because only an open poll can be voted on.
  const allPollsResult = await env.DB.prepare(
    'SELECT COUNT(*) AS total FROM polls WHERE status = ? AND mode IN (?, ?)'
  ).bind(PollStatus.Open, PollMode.Deadline, PollMode.Evergreen).first<{ total: number }>();

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
     SELECT p.id, p.number, p.title, p.description, p.mode, p.poll_type, p.start_at, p.end_at, p.status,
       t.slug AS topic_slug, t.name AS topic_name
     FROM page
     JOIN polls p ON p.id = page.id
     LEFT JOIN topics t ON t.id = p.topic_id
     ORDER BY p.created_at DESC, p.id DESC`
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
        number: row.number,
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

interface PollDetailRowResult {
  id: number;
  number: number;
  title: string;
  description: string | null;
  mode: PollMode;
  poll_type: number;
  start_at: number | null;
  end_at: number | null;
  duration_seconds: number | null;
  status: PollStatus;
  created_at: number;
  topic_slug: string | null;
  topic_name: string | null;
}

async function getPoll(identifierText: string, env: HandlerEnv): Promise<Response> {
  if (!/^[1-9]\d*$/.test(identifierText)) {
    return apiError('INVALID_POLL_ID', 400);
  }

  const identifier = Number(identifierText);
  if (!Number.isSafeInteger(identifier)) {
    return apiError('INVALID_POLL_ID', 400);
  }

  // The public number is tried first, because that is the identifier the site
  // publishes; the primary key is still accepted, so a link that predates the
  // public number keeps working. The response carries both, and every later call
  // (votes, comments, stats, views) uses `id`, which never changes.
  const columns = `p.id, p.number, p.title, p.description, p.mode, p.poll_type, p.start_at, p.end_at,
            p.duration_seconds, p.status, p.created_at,
            t.slug AS topic_slug, t.name AS topic_name`;
  const source = 'FROM polls p LEFT JOIN topics t ON t.id = p.topic_id';
  const visible = 'p.mode IN (?, ?) AND p.status IN (?, ?, ?)';
  const visibleBinds = [
    PollMode.Deadline, PollMode.Evergreen,
    PollStatus.Open, PollStatus.Closed, PollStatus.Archived
  ];
  const poll = await env.DB.prepare(`SELECT ${columns} ${source} WHERE p.number = ? AND ${visible}`)
      .bind(identifier, ...visibleBinds).first<PollDetailRowResult>()
    ?? await env.DB.prepare(`SELECT ${columns} ${source} WHERE p.id = ? AND ${visible}`)
      .bind(identifier, ...visibleBinds).first<PollDetailRowResult>();

  if (!poll) {
    return apiError('POLL_NOT_FOUND', 404);
  }

  const pollId = Number(poll.id);
  // A poll's own page always shows its view total, so a poll with no view rows yet
  // reports zero instead of being indistinguishable from a withheld count. The
  // display threshold only governs the listings (see publicViews).
  const viewCounts = await loadViewCounts(env.DB, [pollId]);
  const views = viewCounts.get(pollId) ?? { total: 0, last7Days: 0 };

  // The options come from the shared engine, so every poll exposes its labeled
  // rows here.
  const options = await getOptionsForPolls(env, [{ id: pollId, poll_type: poll.poll_type }]);
  const pollOptions = options.get(pollId) ?? [];

  const { topic_slug: topicSlugValue, topic_name: topicNameValue, created_at: createdAt, ...pollFields } = poll;

  // The previous and next public polls, so the detail page can offer that
  // navigation without a second request. Computed from the same ordering as the
  // list instead of stored columns (see ../services/pollNav).
  const neighbors = await loadPollNeighbors(env.DB, pollId, Number(createdAt));

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
    status: getPollStatusLabel(poll.status),
    prev: neighbors.prev,
    next: neighbors.next
  }, views }, {
    headers: { 'cache-control': 'no-store' }
  });
}