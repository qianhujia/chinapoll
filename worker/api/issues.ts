import {
  getIssueModeLabel,
  getIssueStatusLabel,
  IssueMode,
  IssueStatus,
  VoteOption,
  toIsoDate
} from '../enums';

const MAX_PAGE_SIZE = 100;

interface IssuesEnv {
  DB: D1Database;
}

interface IssueRow {
  id: number;
  title: string;
  description: string | null;
  mode: IssueMode;
  start_at: number | null;
  end_at: number | null;
  status: IssueStatus;
  approve: number;
  neutral: number;
  oppose: number;
}

export async function handleIssuesRequest(request: Request, url: URL, env: IssuesEnv): Promise<Response> {
  if (request.method !== 'GET') {
    return Response.json({ message: 'method not allowed' }, { status: 405 });
  }

  const issueIdText = url.pathname.slice('/api/issues/'.length);
  if (issueIdText) {
    return getIssue(issueIdText, env);
  }

  const page = Number(url.searchParams.get('page') ?? '1');
  const pageSize = Number(url.searchParams.get('pageSize') ?? '15');
  if (!Number.isSafeInteger(page) || page < 1
    || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    return Response.json({ message: 'invalid pagination parameters' }, { status: 400 });
  }

  const countResult = await env.DB.prepare(
    `SELECT COUNT(*) AS total
     FROM issues
     WHERE status = ? AND title IS NOT NULL AND TRIM(title) != ''
       AND mode IN (?, ?)`
  ).bind(IssueStatus.Open, IssueMode.Deadline, IssueMode.Evergreen).first<{ total: number }>();

  const voteTotalResult = await env.DB.prepare(
    `SELECT COUNT(*) AS total
     FROM votes v
     JOIN issues i ON i.id = v.issue_id
     WHERE i.status = ? AND i.title IS NOT NULL AND TRIM(i.title) != ''
       AND i.mode IN (?, ?)`
  ).bind(IssueStatus.Open, IssueMode.Deadline, IssueMode.Evergreen).first<{ total: number }>();

  const total = Number(countResult?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages);
  const offset = (currentPage - 1) * pageSize;
  const result = await env.DB.prepare(
    `SELECT i.id, i.title, i.description, i.mode, i.start_at, i.end_at, i.status,
       COALESCE(SUM(CASE WHEN v.option = ? THEN 1 ELSE 0 END), 0) AS approve,
       COALESCE(SUM(CASE WHEN v.option = ? THEN 1 ELSE 0 END), 0) AS neutral,
       COALESCE(SUM(CASE WHEN v.option = ? THEN 1 ELSE 0 END), 0) AS oppose
     FROM issues i
     LEFT JOIN votes v ON v.issue_id = i.id
     WHERE i.status = ? AND i.title IS NOT NULL AND TRIM(i.title) != ''
       AND i.mode IN (?, ?)
     GROUP BY i.id
     ORDER BY i.created_at DESC, i.id DESC
     LIMIT ? OFFSET ?`
  ).bind(
    VoteOption.Approve, VoteOption.Neutral, VoteOption.Oppose,
    IssueStatus.Open, IssueMode.Deadline, IssueMode.Evergreen,
    pageSize, offset
  ).all<IssueRow>();

  const issues = (result.results ?? []).map((row) => ({
    issue: {
      id: row.id,
      title: row.title,
      description: row.description,
      mode: getIssueModeLabel(row.mode),
      start_at: toIsoDate(row.start_at),
      end_at: toIsoDate(row.end_at),
      status: getIssueStatusLabel(row.status)
    },
    stats: {
      issueId: row.id,
      counts: {
        approve: Number(row.approve),
        neutral: Number(row.neutral),
        oppose: Number(row.oppose)
      },
      voted: false
    }
  }));

  return Response.json({
    issues,
    page: currentPage,
    pageSize,
    total,
    totalVotes: Number(voteTotalResult?.total ?? 0)
  }, {
    headers: { 'cache-control': 'no-store' }
  });
}

async function getIssue(issueIdText: string, env: IssuesEnv): Promise<Response> {
  if (!/^[1-9]\d*$/.test(issueIdText)) {
    return Response.json({ message: 'invalid issue ID' }, { status: 400 });
  }

  const issueId = Number(issueIdText);
  if (!Number.isSafeInteger(issueId)) {
    return Response.json({ message: 'invalid issue ID' }, { status: 400 });
  }

  const issue = await env.DB.prepare(
    `SELECT id, title, description, mode, start_at, end_at, status
     FROM issues
     WHERE id = ? AND title IS NOT NULL AND TRIM(title) != ''
       AND mode IN (?, ?)
       AND status IN (?, ?, ?)`
  ).bind(
    issueId,
    IssueMode.Deadline, IssueMode.Evergreen,
    IssueStatus.Open, IssueStatus.Closed, IssueStatus.Archived
  ).first<{
    id: number;
    title: string;
    description: string | null;
    mode: IssueMode;
    start_at: number | null;
    end_at: number | null;
    status: IssueStatus;
  }>();

  if (!issue) {
    return Response.json({ message: 'issue not found' }, { status: 404 });
  }

  return Response.json({ issue: {
    ...issue,
    mode: getIssueModeLabel(issue.mode),
    start_at: toIsoDate(issue.start_at),
    end_at: toIsoDate(issue.end_at),
    status: getIssueStatusLabel(issue.status)
  } }, {
    headers: { 'cache-control': 'no-store' }
  });
}
