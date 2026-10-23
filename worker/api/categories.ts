// Public poll topics.
//
// Only enabled topics are listed. Each carries its stored `name` plus a
// `names` object with the label for each of the three locales, and the number of
// open polls it holds so the home page can render its chip row. `total` is the
// number of open polls overall, for the "All" chip.

import type { HandlerEnv } from '../index';
import { PollMode, PollStatus } from '../enums';
import { topicNames } from '../../shared/categories';
import { apiError } from '../../shared/http';

interface TopicRow {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  position: number;
  count: number;
}

export interface EnabledTopic {
  id: number;
  slug: string;
  name: string;
  description: string | null;
}

// The enabled topics in display order. Shared by this endpoint, the AI
// categoriser, and the proposal handler.
export async function loadEnabledTopics(env: { DB: D1Database }): Promise<EnabledTopic[]> {
  const result = await env.DB.prepare(
    'SELECT id, slug, name, description FROM topics WHERE enabled = 1 ORDER BY position ASC, id ASC'
  ).all<EnabledTopic>();
  return (result.results ?? []).map((row) => ({
    id: Number(row.id),
    slug: row.slug,
    name: row.name,
    description: row.description
  }));
}

export async function handleTopicsRequest(request: Request, env: HandlerEnv): Promise<Response> {
  if (request.method !== 'GET') {
    return apiError('METHOD_NOT_ALLOWED', 405);
  }

  const result = await env.DB.prepare(
    `SELECT t.id, t.slug, t.name, t.description, t.position,
            (SELECT COUNT(*) FROM polls p
             WHERE p.topic_id = t.id AND p.status = ? AND p.mode IN (?, ?)) AS count
     FROM topics t
     WHERE t.enabled = 1
     ORDER BY t.position ASC, t.id ASC`
  ).bind(PollStatus.Open, PollMode.Deadline, PollMode.Evergreen).all<TopicRow>();

  const totalRow = await env.DB.prepare(
    'SELECT COUNT(*) AS total FROM polls WHERE status = ? AND mode IN (?, ?)'
  ).bind(PollStatus.Open, PollMode.Deadline, PollMode.Evergreen).first<{ total: number }>();

  return Response.json({
    topics: (result.results ?? []).map((row) => ({
      id: Number(row.id),
      slug: row.slug,
      name: row.name,
      description: row.description,
      position: Number(row.position),
      names: topicNames(row.slug, row.name),
      count: Number(row.count ?? 0)
    })),
    total: Number(totalRow?.total ?? 0)
  }, {
    headers: { 'cache-control': 'no-store' }
  });
}