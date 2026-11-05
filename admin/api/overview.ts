import { PollStatus } from '../../worker/enums';
import { last7DayCutoff, todayBucket } from '../../worker/api/views';
import { publishHealth, recentPublishRuns } from '../../worker/services/publisher';
import type { AdminEnv } from '../auth';

interface CountRow {
  total: number;
}

// How many days the overview's view chart covers.
export const VIEW_CHART_DAYS = 30;

export interface DailyViews {
  /** The UTC day, as `YYYY-MM-DD`. */
  day: string;
  views: number;
}

// The daily view totals of every poll, oldest first, with the days that saw no view
// filled in as zero so the chart has one point per day. `poll_views` holds one row per
// poll per UTC day; the long-term rollup rows (`ts_day = 0`, written by the hourly
// maintenance run for rows older than 90 days) fall outside the window, so they are
// never charted and the chart keeps its daily resolution.
export async function loadDailyViews(env: AdminEnv, days = VIEW_CHART_DAYS): Promise<DailyViews[]> {
  const first = todayBucket() - (days - 1) * 86400;
  const result = await env.DB.prepare(
    `SELECT ts_day, COALESCE(SUM(views), 0) AS views FROM poll_views
     WHERE ts_day >= ? GROUP BY ts_day ORDER BY ts_day ASC`
  ).bind(first).all<{ ts_day: number; views: number }>();

  const byDay = new Map<number, number>();
  for (const row of result.results ?? []) byDay.set(Number(row.ts_day), Number(row.views));

  return Array.from({ length: days }, (_, index) => {
    const tsDay = first + index * 86400;
    return {
      day: new Date(tsDay * 1000).toISOString().slice(0, 10),
      views: byDay.get(tsDay) ?? 0
    };
  });
}

export async function handleOverviewRequest(request: Request, env: AdminEnv): Promise<Response> {
  if (request.method !== 'GET') {
    return Response.json({ message: 'method not allowed' }, { status: 405 });
  }

  const [pending, open, closed, archived, votes, comments, users, settings, adminUsers, auditEntries, views24h, views7d, openReports, openCommentReports, viewsDaily] = await Promise.all([
    count(env, 'SELECT COUNT(*) AS total FROM polls WHERE status = ?', PollStatus.Pending),
    count(env, 'SELECT COUNT(*) AS total FROM polls WHERE status = ?', PollStatus.Open),
    count(env, 'SELECT COUNT(*) AS total FROM polls WHERE status = ?', PollStatus.Closed),
    count(env, 'SELECT COUNT(*) AS total FROM polls WHERE status = ?', PollStatus.Archived),
    count(env, 'SELECT COUNT(*) AS total FROM votes'),
    count(env, 'SELECT COUNT(*) AS total FROM comments'),
    count(env, 'SELECT COUNT(*) AS total FROM users'),
    count(env, 'SELECT COUNT(*) AS total FROM settings'),
    count(env, 'SELECT COUNT(*) AS total FROM admin_users'),
    count(env, 'SELECT COUNT(*) AS total FROM admin_audit_log'),
    sum(env, 'SELECT COALESCE(SUM(views), 0) AS total FROM poll_views WHERE ts_day >= ?', todayBucket()),
    sum(env, 'SELECT COALESCE(SUM(views), 0) AS total FROM poll_views WHERE ts_day >= ?', last7DayCutoff()),
    count(env, 'SELECT COUNT(*) AS total FROM poll_reports WHERE resolved_at IS NULL'),
    count(env, 'SELECT COUNT(*) AS total FROM comment_reports WHERE resolved_at IS NULL'),
    loadDailyViews(env)
  ]);

  const recentPending = await env.DB.prepare(
    `SELECT id, title, mode, created_at
     FROM polls
     WHERE status = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 5`
  ).bind(PollStatus.Pending).all<{ id: number; title: string | null; mode: number; created_at: number }>();

  const [publishRuns, publish] = await Promise.all([
    recentPublishRuns(env, 5),
    publishHealth(env)
  ]);

  return Response.json({
    overview: {
      pending,
      open,
      closed,
      archived,
      votes,
      comments,
      users,
      settings,
      adminUsers,
      auditEntries,
      views24h,
      views7d,
      // The last `VIEW_CHART_DAYS` UTC days of view totals over every poll, one entry
      // per day, oldest first, for the overview's line chart.
      viewsDaily,
      openReports,
      openCommentReports,
      recentPending: (recentPending.results ?? []).map((row) => ({
        id: row.id,
        title: row.title,
        mode: row.mode,
        createdAt: new Date(row.created_at * 1000).toISOString()
      })),
      lastPublishAt: publish.lastPublishAt,
      publishError: publish.publishError,
      publishRuns
    }
  }, {
    headers: { 'cache-control': 'no-store' }
  });
}

async function count(env: AdminEnv, sql: string, ...binds: unknown[]): Promise<number> {
  const statement = binds.length ? env.DB.prepare(sql).bind(...binds) : env.DB.prepare(sql);
  const row = await statement.first<CountRow>();
  return Number(row?.total ?? 0);
}

// Reads a single aggregate value (COUNT or SUM) as a number.
const sum = count;
