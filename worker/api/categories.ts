// Public poll categories.
//
// Only enabled categories are listed. Each carries its stored `name` plus a
// `names` object with the label for each of the three locales, and the number of
// open polls it holds so the home page can render its chip row. `total` is the
// number of open polls overall, for the "All" chip.

import type { HandlerEnv } from '../index';
import { PollMode, PollStatus } from '../enums';
import { categoryNames } from '../../shared/categories';

interface CategoryRow {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  position: number;
  count: number;
}

export interface EnabledCategory {
  id: number;
  slug: string;
  name: string;
  description: string | null;
}

// The enabled categories in display order. Shared by this endpoint, the AI
// categoriser, and the proposal handler.
export async function loadEnabledCategories(env: { DB: D1Database }): Promise<EnabledCategory[]> {
  const result = await env.DB.prepare(
    'SELECT id, slug, name, description FROM categories WHERE enabled = 1 ORDER BY position ASC, id ASC'
  ).all<EnabledCategory>();
  return (result.results ?? []).map((row) => ({
    id: Number(row.id),
    slug: row.slug,
    name: row.name,
    description: row.description
  }));
}

export async function handleCategoriesRequest(request: Request, env: HandlerEnv): Promise<Response> {
  if (request.method !== 'GET') {
    return Response.json({ message: 'method not allowed' }, { status: 405 });
  }

  const result = await env.DB.prepare(
    `SELECT c.id, c.slug, c.name, c.description, c.position,
            (SELECT COUNT(*) FROM polls p
             WHERE p.category_id = c.id AND p.status = ? AND p.mode IN (?, ?)) AS count
     FROM categories c
     WHERE c.enabled = 1
     ORDER BY c.position ASC, c.id ASC`
  ).bind(PollStatus.Open, PollMode.Deadline, PollMode.Evergreen).all<CategoryRow>();

  const totalRow = await env.DB.prepare(
    'SELECT COUNT(*) AS total FROM polls WHERE status = ? AND mode IN (?, ?)'
  ).bind(PollStatus.Open, PollMode.Deadline, PollMode.Evergreen).first<{ total: number }>();

  return Response.json({
    categories: (result.results ?? []).map((row) => ({
      id: Number(row.id),
      slug: row.slug,
      name: row.name,
      description: row.description,
      position: Number(row.position),
      names: categoryNames(row.slug, row.name),
      count: Number(row.count ?? 0)
    })),
    total: Number(totalRow?.total ?? 0)
  }, {
    headers: { 'cache-control': 'no-store' }
  });
}
