import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applySchema } from './helpers';
import { handleSettingsRequest } from '../../admin/api/settings';
import { DEFAULT_PUBLIC_SETTINGS, loadPublicSettings } from '../../worker/api/settings';
import type { AdminActor } from '../../admin/auth';

const ADMIN: AdminActor = { id: 1, username: 'admin', role: 'admin' };

beforeAll(async () => {
  await applySchema();
});

async function settingsRequest(path: string, method: string, body?: unknown): Promise<Response> {
  const request = new Request(`https://admin.example.com${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return handleSettingsRequest(
    request,
    new URL(request.url),
    env as unknown as Parameters<typeof handleSettingsRequest>[2],
    ADMIN
  );
}

function setSetting(key: string, value: string): Promise<unknown> {
  return env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(key, value).run();
}

async function storedValue(key: string): Promise<string | null | undefined> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
    .bind(key).first<{ value: string | null }>();
  return row?.value;
}

async function updateAuditCount(key: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM admin_audit_log WHERE action = 'setting.update' AND target_id = ?"
  ).bind(key).first<{ total: number }>();
  return Number(row?.total ?? 0);
}

describe('admin settings save semantics', () => {
  it('clears an empty input back to the default without storing the default', async () => {
    await setSetting('site_slogan', 'A custom slogan');
    const before = await updateAuditCount('site_slogan');

    const response = await settingsRequest('/api/admin/settings/bulk', 'PUT', { site_slogan: '' });
    expect(response.status).toBe(200);

    // No row is stored; the loader falls back to the schema default.
    expect(await storedValue('site_slogan')).toBeUndefined();
    expect((await loadPublicSettings(env.DB)).site_slogan).toBe(DEFAULT_PUBLIC_SETTINGS.site_slogan);

    // The effective value changed, so exactly one audit entry records the reset.
    expect(await updateAuditCount('site_slogan')).toBe(before + 1);
    const audit = await env.DB.prepare(
      "SELECT details FROM admin_audit_log WHERE action = 'setting.update' AND target_id = ? ORDER BY id DESC LIMIT 1"
    ).bind('site_slogan').first<{ details: string }>();
    expect(JSON.parse(audit?.details ?? '{}')).toMatchObject({
      value: DEFAULT_PUBLIC_SETTINGS.site_slogan,
      default: true
    });
  });

  it('writes nothing and audits nothing when an empty input is already the default', async () => {
    await env.DB.prepare("DELETE FROM settings WHERE key = 'site_slogan'").run();
    const before = await updateAuditCount('site_slogan');

    const response = await settingsRequest('/api/admin/settings/bulk', 'PUT', { site_slogan: '' });
    expect(response.status).toBe(200);

    expect(await storedValue('site_slogan')).toBeUndefined();
    expect(await updateAuditCount('site_slogan')).toBe(before);
  });

  it('does not store or audit a value equal to the default', async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM settings WHERE key = 'read_only_mode'"),
      env.DB.prepare("DELETE FROM settings WHERE key = 'ai_provider'")
    ]);
    const before = await updateAuditCount('read_only_mode') + await updateAuditCount('ai_provider');

    const response = await settingsRequest('/api/admin/settings/bulk', 'PUT', {
      read_only_mode: 'false',
      ai_provider: 'off'
    });
    expect(response.status).toBe(200);

    expect(await storedValue('read_only_mode')).toBeUndefined();
    expect(await storedValue('ai_provider')).toBeUndefined();
    expect(await updateAuditCount('read_only_mode') + await updateAuditCount('ai_provider')).toBe(before);
  });

  it('records only the keys whose value changed in one bulk save', async () => {
    await setSetting('site_name', 'Stored name');
    await env.DB.prepare("DELETE FROM settings WHERE key = 'hero_subtitle'").run();
    const nameBefore = await updateAuditCount('site_name');
    const subtitleBefore = await updateAuditCount('hero_subtitle');

    const response = await settingsRequest('/api/admin/settings/bulk', 'PUT', {
      site_name: 'Stored name',
      hero_subtitle: 'A new subtitle',
      read_only_mode: 'false'
    });
    expect(response.status).toBe(200);

    // The unchanged name is neither rewritten nor audited.
    expect(await updateAuditCount('site_name')).toBe(nameBefore);
    expect(await storedValue('site_name')).toBe('Stored name');
    // Only the changed subtitle gets an audit entry.
    expect(await updateAuditCount('hero_subtitle')).toBe(subtitleBefore + 1);
    expect(await storedValue('hero_subtitle')).toBe('A new subtitle');
  });

  it('removes a redundant row when the submitted value equals the default', async () => {
    await setSetting('comments_per_page', String(DEFAULT_PUBLIC_SETTINGS.comments_per_page));
    const before = await updateAuditCount('comments_per_page');

    const response = await settingsRequest('/api/admin/settings/bulk', 'PUT', {
      comments_per_page: String(DEFAULT_PUBLIC_SETTINGS.comments_per_page)
    });
    expect(response.status).toBe(200);

    // The stored default is removed so the loader serves the default directly.
    expect(await storedValue('comments_per_page')).toBeUndefined();
    // The effective value never changed, so no audit entry is added.
    expect(await updateAuditCount('comments_per_page')).toBe(before);
  });

  it('applies the same rules to the single-setting endpoint', async () => {
    await setSetting('site_slogan', 'Another custom slogan');
    const before = await updateAuditCount('site_slogan');

    const response = await settingsRequest('/api/admin/settings/site_slogan', 'PUT', { value: '' });
    expect(response.status).toBe(200);

    expect(await storedValue('site_slogan')).toBeUndefined();
    expect((await response.json() as { value: string }).value).toBe(DEFAULT_PUBLIC_SETTINGS.site_slogan);
    expect(await updateAuditCount('site_slogan')).toBe(before + 1);
  });

  it('keeps a blank secret unchanged and does not audit it', async () => {
    await setSetting('github_token', 'x'.repeat(64));
    const before = await updateAuditCount('github_token');

    const response = await settingsRequest('/api/admin/settings/bulk', 'PUT', { github_token: '' });
    expect(response.status).toBe(200);

    expect(await storedValue('github_token')).toBe('x'.repeat(64));
    expect(await updateAuditCount('github_token')).toBe(before);
  });
});
