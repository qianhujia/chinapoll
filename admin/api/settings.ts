// Admin settings API: list, update (single and bulk), initialize.

import { DEFAULT_PUBLIC_SETTINGS } from '../../worker/api/settings';
import { runPublisher, testGitHubConnection } from '../../worker/services/publisher';
import type { AdminActor, AdminEnv } from '../auth';
import { logAudit } from '../lib/audit';
import {
  SETTING_KEYS,
  SETTING_CATEGORIES_LIST,
  isSettingKey,
  validateSettingValue,
  maskSettingValue,
  getSettingCategory,
  getSettingLabel,
  getSettingDescription,
  getSettingType,
  getSettingEnumOptions,
  getSettingDefaultApi,
  isSettingPublicApi,
  isSettingSecretApi,
  auditDetailsForSetting,
  type SettingKey,
} from '../lib/settings';
import {
  getSettingsByCategory,
  getSettingSchema,
  SETTING_CATEGORIES,
} from '../../shared/settings';

interface SettingRow {
  key: string;
  value: string | null;
  updated_at: number | null;
}

interface SettingDetail {
  key: SettingKey;
  label: string;
  description?: string;
  type: string;
  category: string;
  value: string | null;
  maskedValue: string | null;
  isSet: boolean;
  isSecret: boolean;
  isPublic: boolean;
  defaultValue: string | number | boolean;
  enumOptions?: { value: string; label: string }[];
  min?: number;
  max?: number;
  updatedAt: string | null;
}

interface CategoryDetail {
  category: string;
  label: string;
  description: string;
  settings: SettingDetail[];
}

export async function handleSettingsRequest(request: Request, url: URL, env: AdminEnv, actor: AdminActor): Promise<Response> {
  if (url.pathname === '/api/admin/settings/initialize') {
    if (request.method !== 'POST') {
      return Response.json({ message: 'method not allowed' }, { status: 405 });
    }
    return initializeSettings(env, actor);
  }

  if (url.pathname === '/api/admin/settings') {
    if (request.method !== 'GET') {
      return Response.json({ message: 'method not allowed' }, { status: 405 });
    }
    return listSettings(env);
  }

  if (url.pathname === '/api/admin/settings/bulk') {
    if (request.method !== 'PUT' && request.method !== 'POST') {
      return Response.json({ message: 'method not allowed' }, { status: 405 });
    }
    return bulkUpdateSettings(request, env, actor);
  }

  // The publish actions are explicit paths and must be matched before the
  // generic per-setting key route below.
  if (url.pathname === '/api/admin/settings/publish/test') {
    if (request.method !== 'POST') {
      return Response.json({ message: 'method not allowed' }, { status: 405 });
    }
    return testPublish(env, actor);
  }

  if (url.pathname === '/api/admin/settings/publish/run') {
    if (request.method !== 'POST') {
      return Response.json({ message: 'method not allowed' }, { status: 405 });
    }
    return publishNow(env, actor);
  }

  const keyMatch = url.pathname.match(/^\/api\/admin\/settings\/([^/]+)$/);
  if (keyMatch) {
    if (request.method !== 'PUT' && request.method !== 'POST') {
      return Response.json({ message: 'method not allowed' }, { status: 405 });
    }
    return updateSetting(decodeURIComponent(keyMatch[1]), request, env, actor);
  }

  return Response.json({ message: 'not found' }, { status: 404 });
}

async function listSettings(env: AdminEnv): Promise<Response> {
  const result = await env.DB.prepare(
    'SELECT key, value, updated_at FROM settings'
  ).all<SettingRow>();

  const stored = new Map<string, SettingRow>();
  for (const row of result.results ?? []) {
    stored.set(row.key, row);
  }

  // Build categorized settings using shared schema
  const categories: CategoryDetail[] = SETTING_CATEGORIES_LIST.map((category) => ({
    category,
    label: SETTING_CATEGORIES[category].label,
    description: SETTING_CATEGORIES[category].description,
    settings: [],
  }));

  const categoryMap = new Map(categories.map((c) => [c.category, c]));

  // Before the provider dropdown existed, `ai_enable = true` meant Workers AI.
  // The public loader still honours that legacy row, so the admin list shows the
  // same effective provider instead of displaying Off and overwriting it on the
  // next save.
  const legacyAiEnabled = stored.get('ai_enable')?.value === 'true';

  const settings = SETTING_KEYS.map((key) => {
    const row = stored.get(key);
    const schema = getSettingSchema(key);
    const legacyProvider = key === 'ai_provider' && row === undefined && legacyAiEnabled;
    const value = legacyProvider ? 'cloudflare' : row?.value ?? null;
    const detail: SettingDetail = {
      key,
      label: getSettingLabel(key),
      description: getSettingDescription(key),
      type: getSettingType(key) ?? 'string',
      category: getSettingCategory(key) ?? 'advanced',
      value,
      maskedValue: maskSettingValue(key, value),
      isSet: row !== undefined || legacyProvider,
      isSecret: isSettingSecretApi(key),
      isPublic: isSettingPublicApi(key),
      defaultValue: getSettingDefaultApi(key) ?? '',
      enumOptions: getSettingEnumOptions(key),
      min: schema?.min,
      max: schema?.max,
      updatedAt: row?.updated_at ? new Date(row.updated_at * 1000).toISOString() : null,
    };

    const cat = categoryMap.get(detail.category);
    if (cat) cat.settings.push(detail);

    return detail;
  });

  return Response.json({
    categories,
    settings,
  }, {
    headers: { 'cache-control': 'no-store' }
  });
}

// The effective stored value of every setting row. A missing key is absent from
// the map (so "not set" and "stored empty" stay distinguishable), while a stored
// NULL is treated as the empty string.
async function loadStoredValues(env: AdminEnv): Promise<Map<string, string>> {
  const result = await env.DB.prepare('SELECT key, value FROM settings')
    .all<{ key: string; value: string | null }>();
  const values = new Map<string, string>();
  for (const row of result.results ?? []) {
    values.set(row.key, row.value ?? '');
  }
  return values;
}

type SettingUpdatePlan =
  | { action: 'unchanged'; value: string; changed: false }
  | { action: 'delete' | 'upsert'; value: string; changed: boolean };

// Decides what one submitted value means:
//
//   - a blank secret means "keep the stored secret" (the form masks it);
//   - any other blank input means "use the default": the row is removed instead
//     of writing the default into D1, because the loader falls back to it;
//   - any non-empty value is an explicit choice and is validated and stored,
//     even when it happens to equal the default. It is only skipped when the
//     stored row already holds exactly that value.
function planSettingUpdate(
  key: SettingKey,
  rawValue: unknown,
  storedValue: string | undefined
): SettingUpdatePlan | { error: string } {
  const value = String(rawValue);

  if (value === '' && isSettingSecretApi(key)) {
    return { action: 'unchanged', value: storedValue ?? '', changed: false };
  }

  if (value === '') {
    const defaultValue = String(getSettingDefaultApi(key) ?? '');
    if (storedValue === undefined) {
      return { action: 'unchanged', value: defaultValue, changed: false };
    }
    return { action: 'delete', value: defaultValue, changed: storedValue !== defaultValue };
  }

  const validation = validateSettingValue(key, value);
  if (!validation.ok) return { error: validation.error };

  if (storedValue === validation.value) {
    return { action: 'unchanged', value: validation.value, changed: false };
  }
  return { action: 'upsert', value: validation.value, changed: true };
}

async function deleteSetting(env: AdminEnv, key: SettingKey): Promise<void> {
  await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(key).run();
}

// Applies one planned update. A delete still runs when the effective value did
// not change, because the redundant default row should not stay in D1; the audit
// entry, however, is only written when the effective value actually changed.
async function applySettingUpdate(
  env: AdminEnv,
  key: SettingKey,
  plan: SettingUpdatePlan,
  actor: AdminActor
): Promise<string> {
  if (plan.action === 'delete') {
    await deleteSetting(env, key);
  } else if (plan.action === 'upsert') {
    await upsertSetting(env, key, plan.value);
  }

  if (!plan.changed) {
    return plan.action === 'unchanged' ? `${key} unchanged.` : `${key} reset to default.`;
  }

  const details = plan.action === 'delete'
    ? { ...auditDetailsForSetting(key, plan.value), default: true }
    : auditDetailsForSetting(key, plan.value);
  await logAudit(env, {
    actor, action: 'setting.update', targetType: 'setting', targetId: key, details
  });

  return plan.action === 'delete' ? `${key} reset to default.` : `Set ${key}.`;
}

async function bulkUpdateSettings(request: Request, env: AdminEnv, actor: AdminActor): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ message: 'invalid JSON' }, { status: 400 });
  }

  const updates = body as Record<string, string>;
  if (!updates || Object.keys(updates).length === 0) {
    return Response.json({ message: 'no settings provided' }, { status: 400 });
  }

  const results: Array<{ key: string; ok: boolean; message?: string; error?: string }> = [];
  const stored = await loadStoredValues(env);

  for (const [key, rawValue] of Object.entries(updates)) {
    if (!isSettingKey(key)) {
      results.push({ key, ok: false, error: `unknown setting key "${key}"` });
      continue;
    }

    const plan = planSettingUpdate(key, rawValue, stored.get(key));
    if ('error' in plan) {
      results.push({ key, ok: false, error: plan.error });
      continue;
    }

    try {
      const message = await applySettingUpdate(env, key, plan, actor);
      // Keep the running map in sync so a repeated key in one request does not
      // audit the same effective value twice.
      if (plan.action === 'delete') stored.delete(key);
      else if (plan.action === 'upsert') stored.set(key, plan.value);
      results.push({ key, ok: true, message });
    } catch (error) {
      results.push({ key, ok: false, error: error instanceof Error ? error.message : 'Failed to update setting.' });
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  return Response.json({
    ok: failed === 0,
    results,
    message: failed === 0 ? 'All settings saved.' : `${failed} setting(s) failed to save.`,
  }, { status: failed === 0 ? 200 : 422 });
}

async function updateSetting(key: string, request: Request, env: AdminEnv, actor: AdminActor): Promise<Response> {
  if (!isSettingKey(key)) {
    return Response.json({ message: `unknown setting key "${key}"` }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ message: 'invalid JSON' }, { status: 400 });
  }

  const rawValue = typeof body === 'object' && body !== null
    ? (body as Record<string, unknown>).value
    : undefined;
  if (rawValue === undefined || rawValue === null) {
    return Response.json({ message: 'a "value" field is required' }, { status: 400 });
  }

  const stored = await loadStoredValues(env);
  const plan = planSettingUpdate(key, rawValue, stored.get(key));
  if ('error' in plan) {
    return Response.json({ message: plan.error }, { status: 422 });
  }

  const message = await applySettingUpdate(env, key, plan, actor);

  return Response.json({
    ok: true,
    key,
    value: maskSettingValue(key, plan.value),
    message
  });
}

async function initializeSettings(env: AdminEnv, actor: AdminActor): Promise<Response> {
  // Preserve an installation that enabled AI before the provider setting
  // existed: initializing the missing keys must not write `ai_provider = off`
  // over an `ai_enable = true` row.
  const legacyAi = await env.DB.prepare("SELECT value FROM settings WHERE key = 'ai_enable'")
    .first<{ value: string | null }>();
  const legacyAiEnabled = legacyAi?.value === 'true';

  const insert = env.DB.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  const statements = SETTING_KEYS.map((key) => {
    const value = key === 'ai_provider' && legacyAiEnabled
      ? 'cloudflare'
      : String(getSettingDefaultApi(key) ?? '');
    return insert.bind(key, value);
  });
  const results = await env.DB.batch(statements);
  const inserted = results.reduce((total, result) => total + Number(result.meta.changes ?? 0), 0);

  await logAudit(env, { actor, action: 'setting.initialize', details: { inserted } });

  return Response.json({
    ok: true,
    inserted,
    message: `Initialized ${inserted} missing setting(s).`
  });
}

export async function upsertSetting(env: AdminEnv, key: SettingKey, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`
  ).bind(key, value).run();
}

// Publish functions
async function testPublish(env: AdminEnv, actor: AdminActor): Promise<Response> {
  const result = await testGitHubConnection(env);
  await logAudit(env, {
    actor,
    action: 'setting.publish_test',
    targetType: 'setting',
    targetId: 'publish_repository',
    details: { ok: result.ok, write: result.write, status: result.status }
  });
  return Response.json({
    ok: result.ok,
    write: result.write,
    status: result.status,
    message: result.message
  }, { headers: { 'cache-control': 'no-store' } });
}

async function publishNow(env: AdminEnv, actor: AdminActor): Promise<Response> {
  const result = await runPublisher(env);
  await logAudit(env, {
    actor,
    action: 'setting.publish_run',
    targetType: 'setting',
    targetId: 'publish_repository',
    details: { skipped: result.skipped, pollsUpdated: result.pollsUpdated, ok: result.ok }
  });
  const message = result.skipped
    ? `Publish skipped: ${result.reason ?? 'not configured'}.`
    : result.ok
      ? `Published ${result.pollsUpdated} poll file(s).`
      : `Publish failed: ${result.error ?? 'unknown error'}`;
  return Response.json({
    ok: result.ok,
    skipped: result.skipped,
    pollsUpdated: result.pollsUpdated,
    commitSha: result.commitSha,
    error: result.error ?? null,
    message
  }, { status: result.ok ? 200 : 502, headers: { 'cache-control': 'no-store' } });
}