// Poll categories: the public listing and filter, admin CRUD, the suggested set,
// the proposal category, and the AI categoriser.

import { beforeAll, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { handleCategoriesRequest as adminCategories } from '../../admin/api/categories';
import { handlePollsRequest as adminPolls } from '../../admin/api/polls';
import { handleAiRequest } from '../../worker/api/ai';
import { handleProposalRequest } from '../../worker/api/proposal';
import { DEFAULT_PUBLIC_SETTINGS } from '../../worker/api/settings';
import type { AdminActor } from '../../admin/auth';
import type { HandlerEnv } from '../../worker/index';
import { ORIGIN, applySchema, lastId, seedPoll } from './helpers';

const ADMIN_ORIGIN = 'https://admin.example.com';
const ACTOR: AdminActor = { id: 1, username: 'admin', role: 'super_admin' };

beforeAll(async () => {
  await applySchema();
  // Written before the first request so the Worker's settings cache sees them.
  await env.DB.batch([
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('user_poll_delay_hours', '0')"),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('user_comment_delay_hours', '0')"),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('proposal_rate_limit', '200/d')"),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('register_rate_limit', '200/d')"),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('max_accounts_per_ip', '100')")
  ]);
});

function adminRequest(path: string, method: string, body?: unknown): Request {
  return new Request(`${ADMIN_ORIGIN}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function adminCategoriesCall(path: string, method: string, body?: unknown): Promise<Response> {
  const request = adminRequest(path, method, body);
  return adminCategories(request, new URL(request.url), env, ACTOR);
}

async function createCategory(slug: string, name: string): Promise<number> {
  const response = await adminCategoriesCall('/api/admin/categories', 'POST', { slug, name });
  expect(response.status).toBe(201);
  return lastId();
}

async function categoryId(slug: string): Promise<number | null> {
  const row = await env.DB.prepare('SELECT id FROM categories WHERE slug = ?')
    .bind(slug).first<{ id: number }>();
  return row ? Number(row.id) : null;
}

async function assignCategory(pollId: number, category: number | null): Promise<void> {
  await env.DB.prepare('UPDATE polls SET category_id = ? WHERE id = ?').bind(category, pollId).run();
}

async function register(username: string): Promise<string> {
  const response = await SELF.fetch(`${ORIGIN}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ username, password: 'test-password-123' })
  });
  expect(response.status).toBe(201);
  return (response.headers.get('set-cookie') ?? '').split(';')[0];
}

function aiEnv(extra: Record<string, unknown> = {}): HandlerEnv {
  return {
    ...env,
    ...DEFAULT_PUBLIC_SETTINGS,
    // The gate settings are pinned here, not taken from the defaults, so a fresh
    // account can submit and use the categoriser.
    user_poll_delay_hours: 0,
    proposal_rate_limit: '100/d',
    ai_enable: true,
    ai_model: 'test-model',
    ai_rate_limit: '1000/h',
    ...extra
  } as unknown as HandlerEnv;
}

function stubAi(payload: unknown): void {
  (env as unknown as { AI: unknown }).AI = { run: async () => payload };
}

function proposalRequest(cookie: string, body: Record<string, unknown>): Request {
  return new Request(`${ORIGIN}/api/proposal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
    body: JSON.stringify(body)
  });
}

describe('poll categories', () => {
  it('lists enabled categories with the three names, counts, and the open total', async () => {
    const id = await createCategory('politics', 'Politics');
    const pollId = await seedPoll({ title: 'A politics poll' });
    await assignCategory(pollId, id);

    const body = await (await SELF.fetch(`${ORIGIN}/api/categories`)).json() as any;
    const entry = body.categories.find((category: any) => category.slug === 'politics');
    expect(entry.names).toEqual({ en: 'Politics', 'zh-CN': '政治', 'zh-TW': '政治' });
    expect(entry.count).toBeGreaterThanOrEqual(1);
    expect(typeof body.total).toBe('number');
  });

  it('filters the public listing by category slug', async () => {
    const id = await createCategory('economy', 'Economy');
    const matched = await seedPoll({ title: 'Economy poll' });
    const other = await seedPoll({ title: 'Uncategorised poll' });
    await assignCategory(matched, id);
    await assignCategory(other, null);

    const body = await (await SELF.fetch(`${ORIGIN}/api/polls?category=economy&pageSize=100`)).json() as any;
    const ids = body.polls.map((entry: any) => entry.poll.id);
    expect(ids).toContain(matched);
    expect(ids).not.toContain(other);
    expect(body.polls.every((entry: any) => entry.poll.category?.slug === 'economy')).toBe(true);
  });

  it('renames, disables, and deletes a category, leaving its polls uncategorised', async () => {
    const id = await createCategory('health', 'Health');
    const pollId = await seedPoll({ title: 'Health poll' });
    await assignCategory(pollId, id);

    const updated = await adminCategoriesCall(`/api/admin/categories/${id}`, 'PUT', {
      name: 'Public health', enabled: false, position: 7
    });
    expect(updated.status).toBe(200);
    expect((await updated.json() as any).category).toMatchObject({
      name: 'Public health', enabled: false, position: 7
    });

    // A disabled category is gone from the public list.
    const listed = await (await SELF.fetch(`${ORIGIN}/api/categories`)).json() as any;
    expect(listed.categories.some((category: any) => category.slug === 'health')).toBe(false);

    expect((await adminCategoriesCall(`/api/admin/categories/${id}`, 'DELETE')).status).toBe(200);
    const row = await env.DB.prepare('SELECT category_id FROM polls WHERE id = ?')
      .bind(pollId).first<{ category_id: number | null }>();
    expect(row?.category_id).toBeNull();
  });

  it('inserts the suggested categories once', async () => {
    const first = await adminCategoriesCall('/api/admin/categories/suggested', 'POST');
    expect(first.status).toBe(201);
    // The earlier tests already created a few of the suggested slugs.
    const inserted = (await first.json() as any).inserted as number;
    expect(inserted).toBeGreaterThanOrEqual(1);
    expect(inserted).toBeLessThanOrEqual(9);

    const again = await adminCategoriesCall('/api/admin/categories/suggested', 'POST');
    expect((await again.json() as any).inserted).toBe(0);

    const total = await env.DB.prepare('SELECT COUNT(*) AS total FROM categories').first<{ total: number }>();
    expect(Number(total?.total ?? 0)).toBeGreaterThanOrEqual(9);
    expect(await categoryId('society')).not.toBeNull();
  });

  it('assigns a category to a poll and records it in the audit log', async () => {
    const id = await categoryId('other');
    expect(id).not.toBeNull();
    const pollId = await seedPoll({ title: 'Assignable poll' });

    const request = adminRequest(`/api/admin/polls/${pollId}/category`, 'PUT', { categoryId: id });
    const response = await adminPolls(request, new URL(request.url), env, ACTOR);
    expect(response.status).toBe(200);

    const audit = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM admin_audit_log WHERE action = 'poll.category'"
    ).first<{ total: number }>();
    expect(Number(audit?.total ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it('stores the submitter category, rejects an unknown slug, and auto-categorises otherwise', async () => {
    const politics = await categoryId('politics');
    const society = await categoryId('society');

    // The submitter's explicit choice is stored.
    const chosen = await register('category-chooser');
    const explicit = await handleProposalRequest(proposalRequest(chosen, {
      title: 'A categorised proposal',
      pollType: 'single_choice',
      duration: 'none',
      category: 'politics',
      options: ['First option', 'Second option']
    }), aiEnv());
    expect(explicit.status).toBe(201);
    const explicitId = Number((await explicit.json() as any).pollId);
    const explicitRow = await env.DB.prepare('SELECT category_id FROM polls WHERE id = ?')
      .bind(explicitId).first<{ category_id: number | null }>();
    expect(explicitRow?.category_id).toBe(politics);

    // An unknown slug is refused.
    const rejected = await handleProposalRequest(proposalRequest(chosen, {
      title: 'An unknown category proposal',
      pollType: 'single_choice',
      duration: 'none',
      category: 'no-such-category',
      options: ['First option', 'Second option']
    }), aiEnv());
    expect(rejected.status).toBe(400);

    // With auto-categorising on and no choice, the model's slug is stored.
    stubAi({ slug: 'society' });
    const auto = await register('category-auto');
    const autoResponse = await handleProposalRequest(proposalRequest(auto, {
      title: 'An auto categorised proposal',
      pollType: 'single_choice',
      duration: 'none',
      options: ['First option', 'Second option']
    }), aiEnv({ ai_auto_categorise: true }));
    expect(autoResponse.status).toBe(201);
    const autoId = Number((await autoResponse.json() as any).pollId);
    const autoRow = await env.DB.prepare('SELECT category_id FROM polls WHERE id = ?')
      .bind(autoId).first<{ category_id: number | null }>();
    expect(autoRow?.category_id).toBe(society);
  });

  it('validates the AI categoriser answer against the enabled list', async () => {
    const cookie = await register('category-ai');

    stubAi({ slug: 'politics' });
    const known = new Request(`${ORIGIN}/api/ai/categorise`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
      body: JSON.stringify({ title: 'Should the city fund a new tram line' })
    });
    expect(await (await handleAiRequest(known, new URL(known.url), aiEnv())).json())
      .toMatchObject({ ok: true, slug: 'politics' });

    // Anything that is not an enabled slug becomes "none".
    stubAi({ slug: 'not-a-category' });
    const unknown = new Request(`${ORIGIN}/api/ai/categorise`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
      body: JSON.stringify({ title: 'Should the city fund a new tram line' })
    });
    expect(await (await handleAiRequest(unknown, new URL(unknown.url), aiEnv())).json())
      .toMatchObject({ ok: true, slug: 'none' });
  });
});

