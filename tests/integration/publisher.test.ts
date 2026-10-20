import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, createScheduledController, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../worker/index';
import { makeSnapshot, serializeOptionCounts } from '../../worker/services/snapshot';
import { runPublisher } from '../../worker/services/publisher';
import { ORIGIN, applySchema, seedPoll } from './helpers';

beforeAll(async () => {
  await applySchema();
});

// A minimal in-memory GitHub API so the publisher can be exercised without a
// network. It supports exactly the Git Data endpoints the publisher uses.
interface GitHubStub {
  authorized: boolean;
  calls: string[];
  commits: Array<{ message: string; files: string[] }>;
  files: Map<string, string>;
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function createGitHubStub(): GitHubStub {
  const stub: GitHubStub = {
    authorized: true,
    calls: [],
    commits: [],
    files: new Map()
  };
  const blobs = new Map<string, string>();
  const tree = new Map<string, string>();
  let headSha = 'commit-0';
  let treeSha = 'tree-0';
  let counter = 0;
  const nextSha = (prefix: string) => `${prefix}-${(counter += 1)}`;

  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname;
    stub.calls.push(`${method} ${path}`);
    if (!stub.authorized) return json({ message: 'Bad credentials' }, 401);

    if (method === 'GET' && /\/git\/ref\/heads\/.+$/.test(path)) {
      return json({ object: { sha: headSha } });
    }
    if (method === 'GET' && /\/git\/commits\/[^/]+$/.test(path)) {
      return json({ tree: { sha: treeSha } });
    }
    if (method === 'GET' && /\/git\/trees\/[^/]+$/.test(path)) {
      return json({
        tree: [...tree.entries()].map(([entryPath, sha]) => ({
          path: entryPath, sha, type: 'blob', mode: '100644'
        }))
      });
    }
    if (method === 'GET' && /\/git\/blobs\/[^/]+$/.test(path)) {
      const sha = path.split('/').pop() as string;
      if (!blobs.has(sha)) return json({ message: 'Not Found' }, 404);
      return json({ content: toBase64(blobs.get(sha) as string), encoding: 'base64' });
    }
    if (method === 'POST' && /\/git\/blobs$/.test(path)) {
      const body = JSON.parse(String(init?.body)) as { content: string };
      const sha = nextSha('blob');
      blobs.set(sha, body.content);
      return json({ sha });
    }
    if (method === 'POST' && /\/git\/trees$/.test(path)) {
      const body = JSON.parse(String(init?.body)) as { tree: Array<{ path: string; sha: string }> };
      for (const entry of body.tree) {
        tree.set(entry.path, entry.sha);
        stub.files.set(entry.path, blobs.get(entry.sha) ?? '');
      }
      treeSha = nextSha('tree');
      return json({ sha: treeSha });
    }
    if (method === 'POST' && /\/git\/commits$/.test(path)) {
      const body = JSON.parse(String(init?.body)) as { message: string; tree: string };
      stub.commits.push({ message: body.message, files: [...tree.keys()] });
      headSha = nextSha('commit');
      treeSha = body.tree;
      return json({ sha: headSha });
    }
    if (method === 'PATCH' && /\/git\/refs\/heads\/.+$/.test(path)) {
      const body = JSON.parse(String(init?.body)) as { sha: string };
      headSha = body.sha;
      return json({ object: { sha: headSha } });
    }
    return json({ message: `unhandled ${method} ${path}` }, 404);
  });

  return stub;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// Writes the publish settings used by a test. Only the keys passed are written.
async function setPublishSettings(values: Record<string, string>): Promise<void> {
  await env.DB.batch(Object.entries(values).map(([key, value]) => env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`
  ).bind(key, value)));
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM publish_state'),
    env.DB.prepare('DELETE FROM publish_runs'),
    env.DB.prepare(`DELETE FROM settings WHERE key IN
      ('publish_enable', 'publish_repository', 'publish_branch', 'publish_path', 'github_token')`),
    // Each test starts from an empty poll table so the tracked set is exact.
    env.DB.prepare('DELETE FROM vote_selections'),
    env.DB.prepare('DELETE FROM votes'),
    env.DB.prepare('DELETE FROM poll_options'),
    env.DB.prepare('DELETE FROM poll_views'),
    env.DB.prepare('DELETE FROM poll_reports'),
    env.DB.prepare('DELETE FROM stats_snapshots'),
    env.DB.prepare('DELETE FROM polls')
  ]);
});

const TOKEN = 'github_pat_' + 'a'.repeat(60);

// Inserts a signed snapshot row directly and returns its hash.
async function insertSnapshot(
  pollId: number,
  tsHour: number,
  ballots: number,
  prevHash: string,
  final: boolean
): Promise<string> {
  const snapshot = await makeSnapshot({ pollId, tsHour, ballots, views: ballots, prevHash });
  await env.DB.prepare(
    `INSERT INTO stats_snapshots (poll_id, ts_hour, ballots, option_counts, views, prev_hash, hash, final)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(poll_id, ts_hour) DO UPDATE SET
       ballots = excluded.ballots,
       views = excluded.views,
       prev_hash = excluded.prev_hash,
       hash = excluded.hash,
       final = excluded.final`
  ).bind(
    pollId, snapshot.tsHour, snapshot.ballots,
    serializeOptionCounts(snapshot.optionCounts), snapshot.views,
    snapshot.prevHash, snapshot.hash, final ? 1 : 0
  ).run();
  return snapshot.hash;
}

async function publishState(pollId: number): Promise<{ published_through: number; final: number } | null> {
  return env.DB.prepare('SELECT published_through, final FROM publish_state WHERE poll_id = ?')
    .bind(pollId).first<{ published_through: number; final: number }>();
}

async function runCount(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS total FROM publish_runs').first<{ total: number }>();
  return Number(row?.total ?? 0);
}


describe('publisher', () => {
  it('skips while the publish_enable setting is off', async () => {
    const stub = createGitHubStub();
    await setPublishSettings({
      publish_enable: 'false',
      publish_repository: 'owner/data',
      publish_branch: 'main',
      publish_path: 'snapshots',
      github_token: TOKEN
    });
    const pollId = await seedPoll({ title: 'Disabled poll' });
    await insertSnapshot(pollId, 1_000, 1, 'GENESIS', false);

    const result = await runPublisher(env);

    expect(result.skipped).toBe(true);
    expect(stub.calls).toHaveLength(0);
    expect(await runCount()).toBe(0);
  });

  it('skips and records nothing when the token is missing', async () => {
    const stub = createGitHubStub();
    await setPublishSettings({
      publish_enable: 'true',
      publish_repository: 'owner/data'
    });
    const pollId = await seedPoll({ title: 'No token poll' });
    await insertSnapshot(pollId, 1_000, 1, 'GENESIS', false);

    const result = await runPublisher(env);

    expect(result.skipped).toBe(true);
    expect(stub.calls).toHaveLength(0);
    expect(await runCount()).toBe(0);
  });

  it('publishes every tracked poll and sets published_through on the first run', async () => {
    const stub = createGitHubStub();
    await setPublishSettings({
      publish_enable: 'true',
      publish_repository: 'owner/data',
      publish_branch: 'main',
      publish_path: 'snapshots',
      github_token: TOKEN
    });
    const first = await seedPoll({ title: 'First poll' });
    const second = await seedPoll({ title: 'Second poll' });
    await insertSnapshot(first, 5_000, 1, 'GENESIS', false);
    await insertSnapshot(first, 5_001, 2, 'GENESIS', false);
    await insertSnapshot(second, 5_000, 3, 'GENESIS', false);

    const result = await runPublisher(env, 100_000);

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.pollsUpdated).toBe(2);
    expect(stub.commits).toHaveLength(1);
    expect(stub.commits[0].files).toContain('snapshots/index.json');
    expect(stub.commits[0].files).toContain(`snapshots/${first}.json`);
    expect(stub.commits[0].files).toContain(`snapshots/${second}.json`);
    expect(await publishState(first)).toMatchObject({ published_through: 5_001 });
    expect(await publishState(second)).toMatchObject({ published_through: 5_000 });
    expect(await runCount()).toBe(1);
  });

  it('makes no commit on a second run when no new rows exist', async () => {
    const stub = createGitHubStub();
    await setPublishSettings({
      publish_enable: 'true',
      publish_repository: 'owner/data',
      publish_branch: 'main',
      publish_path: 'snapshots',
      github_token: TOKEN
    });
    const pollId = await seedPoll({ title: 'Stable poll' });
    await insertSnapshot(pollId, 6_000, 1, 'GENESIS', true);

    const firstRun = await runPublisher(env, 100_000);
    expect(firstRun.pollsUpdated).toBe(1);
    expect(stub.commits).toHaveLength(1);

    const secondRun = await runPublisher(env, 103_600);
    expect(secondRun.ok).toBe(true);
    expect(secondRun.pollsUpdated).toBe(0);
    // The final row needs no re-fetch, so no commit is created.
    expect(stub.commits).toHaveLength(1);
  });

  it('re-fetches a closed poll and marks it final', async () => {
    const stub = createGitHubStub();
    await setPublishSettings({
      publish_enable: 'true',
      publish_repository: 'owner/data',
      publish_branch: 'main',
      publish_path: 'snapshots',
      github_token: TOKEN
    });
    const pollId = await seedPoll({ title: 'Closing poll' });
    await insertSnapshot(pollId, 7_000, 1, 'GENESIS', false);
    await insertSnapshot(pollId, 7_001, 2, 'GENESIS', false);

    await runPublisher(env, 100_000);
    expect(await publishState(pollId)).toMatchObject({ published_through: 7_001, final: 0 });

    // The poll closes: the closing hour is rewritten with the terminal counts,
    // hash, and final flag.
    await insertSnapshot(pollId, 7_001, 5, 'GENESIS', true);

    const secondRun = await runPublisher(env, 103_600);
    expect(secondRun.pollsUpdated).toBe(1);
    expect(await publishState(pollId)).toMatchObject({ published_through: 7_001, final: 1 });

    const file = JSON.parse(stub.files.get(`snapshots/${pollId}.json`) ?? '{}') as {
      snapshots: Array<{ tsHourEpoch: number; final: boolean; ballots: number }>;
    };
    expect(file.snapshots.at(-1)).toMatchObject({ tsHourEpoch: 7_001, final: true, ballots: 5 });
  });

  it('records a GitHub 401 in publish_runs and does not fail the cron', async () => {
    const stub = createGitHubStub();
    stub.authorized = false;
    await setPublishSettings({
      publish_enable: 'true',
      publish_repository: 'owner/data',
      publish_branch: 'main',
      publish_path: 'snapshots',
      github_token: TOKEN
    });
    const pollId = await seedPoll({ title: 'Unauthorized poll' });
    await insertSnapshot(pollId, 8_000, 1, 'GENESIS', false);

    const result = await runPublisher(env, 100_000);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('401');

    const run = await env.DB.prepare('SELECT error FROM publish_runs ORDER BY id DESC LIMIT 1')
      .first<{ error: string | null }>();
    expect(run?.error).toContain('401');

    // The scheduled handler swallows the failure: the rest of maintenance still
    // completes and the handler resolves.
    const controller = createScheduledController({ scheduledTime: new Date(), cron: '0 * * * *' });
    const ctx = createExecutionContext();
    await expect(worker.scheduled!(controller, env, ctx)).resolves.toBeUndefined();
    await waitOnExecutionContext(ctx);
  });

  it('reports lastPublishAt and publishError on /api/health', async () => {
    await env.DB.prepare(
      "INSERT INTO publish_runs (started_at, finished_at, polls_updated, error) VALUES (1, 3600, 2, NULL)"
    ).run();
    const healthy = await (await SELF.fetch(`${ORIGIN}/api/health`)).json() as any;
    expect(healthy.publishError).toBe(false);
    expect(typeof healthy.lastPublishAt).toBe('string');

    // A newer failing run flips publishError without changing `ok`.
    await env.DB.prepare(
      "INSERT INTO publish_runs (started_at, finished_at, polls_updated, error) VALUES (2, 7200, 0, 'GitHub read branch ref failed with status 401')"
    ).run();
    const failing = await (await SELF.fetch(`${ORIGIN}/api/health`)).json() as any;
    expect(failing.publishError).toBe(true);
    expect(failing.ok).toBe(true);
  });

  it('publishes at most 40 polls in one run and carries the remainder', async () => {
    const stub = createGitHubStub();
    await setPublishSettings({
      publish_enable: 'true',
      publish_repository: 'owner/data',
      publish_branch: 'main',
      publish_path: 'snapshots',
      github_token: TOKEN
    });
    // One more poll than a batch, so the first run must leave one behind.
    for (let index = 0; index < 41; index += 1) {
      const pollId = await seedPoll({ title: `Batch poll ${index}` });
      await insertSnapshot(pollId, 9_000, 1, 'GENESIS', true);
    }

    const first = await runPublisher(env, 100_000);
    expect(first.pollsUpdated).toBe(40);
    expect(stub.commits).toHaveLength(1);

    // The batch cursor carries the remaining poll to the next run.
    const second = await runPublisher(env, 100_000);
    expect(second.pollsUpdated).toBe(1);
    expect(stub.commits).toHaveLength(2);
  });

  it('describes every poll entry in index.json with its category slug', async () => {
    const stub = createGitHubStub();
    await setPublishSettings({
      publish_enable: 'true',
      publish_repository: 'owner/data',
      publish_branch: 'main',
      publish_path: 'snapshots',
      github_token: TOKEN
    });
    const pollId = await seedPoll({ title: 'Index category poll' });
    await insertSnapshot(pollId, 11_000, 1, 'GENESIS', true);

    const result = await runPublisher(env, 100_000);
    expect(result.pollsUpdated).toBe(1);

    const index = JSON.parse(stub.files.get('snapshots/index.json') ?? '{}') as {
      polls: Array<{ id: number; categorySlug: string | null }>;
    };
    const entry = index.polls.find((item) => item.id === pollId);
    expect(entry).toBeDefined();
    // The slug is metadata: it is absent (null) for an uncategorised poll and is
    // never part of the hashed snapshot chain.
    expect(entry?.categorySlug ?? null).toBeNull();
  });
});

