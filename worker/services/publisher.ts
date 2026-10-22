// Worker-side publisher for the public audit repository.
//
// The publisher copies the signed snapshot chain of every open poll and every
// recently closed poll to a GitHub data repository, so the published counts are
// copied outside the operator's database and become tamper-evident. It replaces
// the former GitHub Actions workflow and keeps the same append-only behaviour:
//
//   * a poll that closed within the retention window is still copied, so its
//     final chain is always published;
//   * new snapshots are merged into the existing poll file by hour, and a poll
//     file is never deleted;
//   * when the last published hour is not final, that hour is re-read so a close
//     that lands after the previous run replaces the stale row in place.
//
// One commit per run: the Git Data API creates one blob per changed file plus
// `index.json`, one tree, one commit, and updates the branch ref, so the number
// of subrequests stays near the number of changed polls and the history is a
// clean series of hourly commits.

import { PUBLISH_REPOSITORY_PATTERN, loadPublicSettings } from '../api/settings';
import { PollStatus } from '../enums';
import { parseOptionCounts } from './snapshot';

export interface PublisherEnv {
  DB: D1Database;
}

// Recently closed polls are re-fetched for this long after they close.
const CLOSED_DAYS = 35;
// The dashboard keeps only the most recent publisher runs.
const RUN_HISTORY_LIMIT = 50;
// The most polls examined in one run. A run makes one read per examined poll, so
// this bounds the subrequests on a plan with a per-invocation limit; the
// unprocessed remainder is carried to the next run by the batch cursor.
const BATCH_SIZE = 40;
// The reserved `publish_state` row (poll_id = 0) that holds the batch cursor.
const BATCH_CURSOR_POLL_ID = 0;
// The schema version of the copied chain.
const SNAPSHOT_SCHEMA_VERSION = 3;
const GITHUB_API = 'https://api.github.com';
const USER_AGENT = 'chinapoll-worker';
// The commit identity recorded on every published commit.
const COMMIT_AUTHOR = { name: 'chinapoll-bot', email: 'bot@users.noreply.github.com' };

// A record as stored in a published poll file and returned by the snapshot API.
export interface PublishedSnapshot {
  tsHour: string;
  tsHourEpoch: number;
  ballots: number;
  optionCounts: Array<{ position: number; count: number }> | null;
  views: number;
  prevHash: string;
  hash: string;
  final: boolean;
}

export interface PublishSettings {
  enable: boolean;
  repository: string;
  branch: string;
  path: string;
  token: string;
}

export interface PublishResult {
  ok: boolean;
  skipped: boolean;
  reason?: string;
  pollsUpdated: number;
  commitSha: string | null;
  error?: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  write: boolean;
  status: number;
  message: string;
}

interface SnapshotRow {
  ts_hour: number;
  ballots: number;
  option_counts: string | null;
  views: number;
  prev_hash: string;
  hash: string;
  final: number;
}

interface PublishStateRow {
  poll_id: number;
  published_through: number;
  final: number;
}

interface TrackedState {
  publishedThrough: number;
  final: boolean;
}

interface HeadTree {
  headSha: string;
  treeSha: string;
  blobs: Map<string, string>;
}

// Returns the hour of a stored or published snapshot, treating a missing value
// as zero.
export function snapshotHour(snapshot: { tsHourEpoch?: number } | null | undefined): number {
  return Number(snapshot?.tsHourEpoch ?? 0);
}

// Returns the cursor the next fetch should start after. When the newest stored
// snapshot is not marked final, start one hour earlier so the closing hour is
// fetched again: a close that runs after the previous publish rewrites that
// hour's counts, hash, and final flag in place. `mergeSnapshots` then replaces
// the stale row by hour.
export function resumeAfter(
  stored: ReadonlyArray<{ tsHourEpoch?: number; final?: boolean }>
): number {
  let last: { tsHourEpoch?: number; final?: boolean } | null = null;
  for (const snapshot of stored) {
    if (last === null || snapshotHour(snapshot) > snapshotHour(last)) last = snapshot;
  }
  if (!last) return 0;
  const lastHour = snapshotHour(last);
  return last.final === true ? lastHour : Math.max(0, lastHour - 1);
}

// Merges stored and newly fetched snapshots by hour so a re-run cannot
// duplicate and a refreshed closing hour replaces the stale row.
export function mergeSnapshots<T extends { tsHourEpoch?: number }>(
  stored: ReadonlyArray<T>,
  added: ReadonlyArray<T>
): T[] {
  const byHour = new Map<number, T>();
  for (const snapshot of [...stored, ...added]) {
    const hour = snapshotHour(snapshot);
    if (hour > 0) byHour.set(hour, snapshot);
  }
  return [...byHour.entries()].sort((left, right) => left[0] - right[0]).map(([, snapshot]) => snapshot);
}

// Reads the publish settings from the database and shapes them for the
// publisher. A malformed stored value makes `loadPublicSettings` throw, which
// the caller records as a failed run.
async function readPublishSettings(env: PublisherEnv): Promise<PublishSettings> {
  const settings = await loadPublicSettings(env.DB);
  return {
    enable: settings.publish_enable === true,
    repository: String(settings.publish_repository ?? ''),
    branch: String(settings.publish_branch ?? 'main'),
    path: String(settings.publish_path ?? 'snapshots'),
    token: String(settings.github_token ?? '')
  };
}

// Lists the polls the publisher tracks: every open poll plus every poll that
// closed within the retention window. Each entry carries the poll's topic slug
// for the published `index.json`; the slug is metadata and is not part of the
// hashed snapshot chain, which covers counts only.
async function listTrackedPolls(
  env: PublisherEnv,
  now: number
): Promise<Array<{ id: number; topicSlug: string | null }>> {
  const cutoff = now - CLOSED_DAYS * 24 * 60 * 60;
  const result = await env.DB.prepare(
    `SELECT p.id, t.slug AS topic_slug
     FROM polls p
     LEFT JOIN topics t ON t.id = p.topic_id
     WHERE p.status = ? OR (p.closed_at IS NOT NULL AND p.closed_at >= ?)
     ORDER BY p.id ASC`
  ).bind(PollStatus.Open, cutoff).all<{ id: number; topic_slug: string | null }>();
  const byId = new Map<number, string | null>();
  for (const row of result.results ?? []) byId.set(Number(row.id), row.topic_slug ?? null);
  return [...byId.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([id, topicSlug]) => ({ id, topicSlug }));
}

// Reads the publish cursor of every poll that has been published at least once.
// The reserved batch-cursor row (poll_id = 0) is skipped.
async function loadPublishState(env: PublisherEnv): Promise<Map<number, TrackedState>> {
  const result = await env.DB.prepare(
    'SELECT poll_id, published_through, final FROM publish_state'
  ).all<PublishStateRow>();
  const states = new Map<number, TrackedState>();
  for (const row of result.results ?? []) {
    const pollId = Number(row.poll_id);
    if (pollId <= 0) continue;
    states.set(pollId, {
      publishedThrough: Number(row.published_through),
      final: Number(row.final) === 1
    });
  }
  return states;
}

// Reads the snapshot rows of one poll newer than the cursor, shaped exactly like
// the snapshot API response so an existing poll file stays compatible.
async function fetchSnapshotRows(
  env: PublisherEnv,
  pollId: number,
  after: number
): Promise<PublishedSnapshot[]> {
  const result = await env.DB.prepare(
    `SELECT ts_hour, ballots, option_counts, views, prev_hash, hash, final
     FROM stats_snapshots WHERE poll_id = ? AND ts_hour > ? ORDER BY ts_hour ASC`
  ).bind(pollId, after).all<SnapshotRow>();
  return (result.results ?? []).map((row) => ({
    tsHour: new Date(Number(row.ts_hour) * 1000).toISOString(),
    tsHourEpoch: Number(row.ts_hour),
    ballots: Number(row.ballots ?? 0),
    optionCounts: parseOptionCounts(row.option_counts),
    views: Number(row.views),
    prevHash: row.prev_hash,
    hash: row.hash,
    final: Number(row.final) === 1
  }));
}

// Persists the publish cursor for the polls whose files were rewritten.
async function savePublishState(
  env: PublisherEnv,
  updates: ReadonlyArray<{ pollId: number; publishedThrough: number; final: boolean }>
): Promise<void> {
  if (updates.length === 0) return;
  await env.DB.batch(updates.map((update) => env.DB.prepare(
    `INSERT INTO publish_state (poll_id, published_through, final) VALUES (?, ?, ?)
     ON CONFLICT(poll_id) DO UPDATE SET
       published_through = excluded.published_through,
       final = excluded.final`
  ).bind(update.pollId, update.publishedThrough, update.final ? 1 : 0)));
}

// Reads the batch cursor: the last poll id a run examined. It is stored in the
// reserved `publish_state` row (poll_id = 0) so the unprocessed remainder of the
// tracked polls is carried to the next run.
async function loadBatchCursor(env: PublisherEnv): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT published_through FROM publish_state WHERE poll_id = ?'
  ).bind(BATCH_CURSOR_POLL_ID).first<{ published_through: number }>();
  return Number(row?.published_through ?? 0);
}

async function saveBatchCursor(env: PublisherEnv, cursor: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO publish_state (poll_id, published_through, final) VALUES (?, ?, 0)
     ON CONFLICT(poll_id) DO UPDATE SET published_through = excluded.published_through`
  ).bind(BATCH_CURSOR_POLL_ID, cursor).run();
}

// Records one publisher run and keeps only the most recent RUN_HISTORY_LIMIT
// rows. A failure to record never breaks the caller.
async function recordRun(
  env: PublisherEnv,
  startedAt: number,
  finishedAt: number,
  pollsUpdated: number,
  error: string | null
): Promise<void> {
  try {
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO publish_runs (started_at, finished_at, polls_updated, error) VALUES (?, ?, ?, ?)'
      ).bind(startedAt, finishedAt, pollsUpdated, error),
      env.DB.prepare(
        `DELETE FROM publish_runs WHERE id NOT IN
           (SELECT id FROM publish_runs ORDER BY id DESC LIMIT ?)`
      ).bind(RUN_HISTORY_LIMIT)
    ]);
  } catch (dbError) {
    console.error('publish run could not be recorded', dbError instanceof Error ? dbError.message : dbError);
  }
}


// Normalizes a configured repository path: no leading or trailing slashes and no
// empty segments. An empty result means the repository root.
function normalizeDirectory(value: string): string {
  return value.split('/').map((segment) => segment.trim()).filter((segment) => segment.length > 0).join('/');
}

// Builds a request to the GitHub REST API. The token is only ever placed in the
// Authorization header and is never logged.
function githubRequest(url: string, token: string, method = 'GET', body?: unknown): Promise<Response> {
  return fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': USER_AGENT,
      'content-type': 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

// Builds an error that carries the status and the GitHub message but never the
// token.
async function githubError(response: Response, action: string): Promise<Error> {
  let detail = '';
  try {
    const body = await response.json() as { message?: string };
    if (body?.message) detail = `: ${body.message}`;
  } catch {
    // A response without a JSON body still carries a usable status code.
  }
  return new Error(`GitHub ${action} failed with status ${response.status}${detail}`);
}

// Reads the branch head, its tree, and every blob path in that tree.
async function loadHeadTree(base: string, branch: string, token: string): Promise<HeadTree> {
  const refResponse = await githubRequest(`${base}/git/ref/heads/${encodeURIComponent(branch)}`, token);
  if (!refResponse.ok) throw await githubError(refResponse, 'read branch ref');
  const ref = await refResponse.json() as { object?: { sha?: string } };
  const headSha = ref.object?.sha;
  if (!headSha) throw new Error('GitHub branch ref did not include a commit SHA');

  const commitResponse = await githubRequest(`${base}/git/commits/${headSha}`, token);
  if (!commitResponse.ok) throw await githubError(commitResponse, 'read base commit');
  const commit = await commitResponse.json() as { tree?: { sha?: string } };
  const treeSha = commit.tree?.sha;
  if (!treeSha) throw new Error('GitHub base commit did not include a tree SHA');

  const treeResponse = await githubRequest(`${base}/git/trees/${treeSha}?recursive=1`, token);
  if (!treeResponse.ok) throw await githubError(treeResponse, 'read base tree');
  const tree = await treeResponse.json() as { tree?: Array<{ path?: string; sha?: string; type?: string }> };
  const blobs = new Map<string, string>();
  for (const entry of tree.tree ?? []) {
    if (entry.type === 'blob' && entry.path && entry.sha) blobs.set(entry.path, entry.sha);
  }
  return { headSha, treeSha, blobs };
}

// Reads a published poll file blob and returns its snapshots, or null when the
// file is missing or unreadable.
async function readPublishedSnapshots(
  base: string,
  blobSha: string,
  token: string
): Promise<PublishedSnapshot[] | null> {
  const response = await githubRequest(`${base}/git/blobs/${blobSha}`, token);
  if (!response.ok) throw await githubError(response, 'read blob');
  const body = await response.json() as { content?: string; encoding?: string };
  if (!body.content) return null;
  try {
    const text = body.encoding === 'base64'
      ? atob(body.content.replace(/\s/g, ''))
      : body.content;
    const parsed = JSON.parse(text) as { snapshots?: PublishedSnapshot[] };
    return Array.isArray(parsed?.snapshots) ? parsed.snapshots : [];
  } catch {
    return null;
  }
}



// Creates one commit that replaces the given files and moves the branch ref. The
// caller has already read the head tree.
async function createCommit(
  base: string,
  branch: string,
  token: string,
  head: HeadTree,
  files: ReadonlyArray<{ path: string; content: string }>,
  message: string
): Promise<string> {
  const treeEntries: Array<{ path: string; mode: string; type: string; sha: string }> = [];
  for (const file of files) {
    const blobResponse = await githubRequest(`${base}/git/blobs`, token, 'POST', {
      content: file.content,
      encoding: 'utf-8'
    });
    if (!blobResponse.ok) throw await githubError(blobResponse, `create blob for ${file.path}`);
    const blob = await blobResponse.json() as { sha?: string };
    if (!blob.sha) throw new Error(`GitHub did not return a blob SHA for ${file.path}`);
    treeEntries.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
  }

  const treeResponse = await githubRequest(`${base}/git/trees`, token, 'POST', {
    base_tree: head.treeSha,
    tree: treeEntries
  });
  if (!treeResponse.ok) throw await githubError(treeResponse, 'create tree');
  const tree = await treeResponse.json() as { sha?: string };
  if (!tree.sha) throw new Error('GitHub did not return a tree SHA');

  const commitResponse = await githubRequest(`${base}/git/commits`, token, 'POST', {
    message,
    tree: tree.sha,
    parents: [head.headSha],
    author: { ...COMMIT_AUTHOR },
    committer: { ...COMMIT_AUTHOR }
  });
  if (!commitResponse.ok) throw await githubError(commitResponse, 'create commit');
  const commit = await commitResponse.json() as { sha?: string };
  if (!commit.sha) throw new Error('GitHub did not return a commit SHA');

  const updateResponse = await githubRequest(
    `${base}/git/refs/heads/${encodeURIComponent(branch)}`,
    token,
    'PATCH',
    { sha: commit.sha, force: false }
  );
  if (!updateResponse.ok) throw await githubError(updateResponse, 'update branch ref');
  return commit.sha;
}

// The ISO hour used in the commit message.
function isoHour(now: number): string {
  return new Date(Math.floor(now / 3600) * 3600 * 1000).toISOString();
}

// Publishes the changed poll files in one commit and returns how many were
// updated.
async function publishOnce(
  env: PublisherEnv,
  settings: PublishSettings,
  now: number
): Promise<{ pollsUpdated: number; commitSha: string | null }> {
  const [owner, repo] = settings.repository.split('/');
  const base = `${GITHUB_API}/repos/${owner}/${repo}`;
  const directory = normalizeDirectory(settings.path);
  const pathFor = (name: string) => (directory ? `${directory}/${name}` : name);

  const tracked = await listTrackedPolls(env, now);
  const allIds = tracked.map((entry) => entry.id);
  const states = await loadPublishState(env);

  // Examine at most BATCH_SIZE polls per run, starting after the poll named by
  // the batch cursor so every tracked poll is reached in turn. When the batch
  // reaches the end of the list the cursor resets to 0 for the next cycle, so the
  // unprocessed remainder is carried to the next run rather than starved.
  const cursor = await loadBatchCursor(env);
  let start = allIds.findIndex((id) => id > cursor);
  if (start === -1) start = 0;
  const pollIds = allIds.slice(start, start + BATCH_SIZE);
  await saveBatchCursor(
    env,
    pollIds.length === 0 || start + pollIds.length >= allIds.length
      ? 0
      : pollIds[pollIds.length - 1]
  );

  // Find the polls in this batch that have new snapshot rows, without touching
  // GitHub.
  const candidates: Array<{ pollId: number; path: string; added: PublishedSnapshot[] }> = [];
  for (const pollId of pollIds) {
    const state = states.get(pollId);
    const after = state
      ? (state.final ? state.publishedThrough : Math.max(0, state.publishedThrough - 1))
      : 0;
    const added = await fetchSnapshotRows(env, pollId, after);
    if (added.length === 0) continue;
    candidates.push({ pollId, path: pathFor(`${pollId}.json`), added });
  }
  if (candidates.length === 0) return { pollsUpdated: 0, commitSha: null };

  const head = await loadHeadTree(base, settings.branch, settings.token);

  const files: Array<{ path: string; content: string }> = [];
  const stateUpdates: Array<{ pollId: number; publishedThrough: number; final: boolean }> = [];
  for (const candidate of candidates) {
    const blobSha = head.blobs.get(candidate.path);
    const stored = blobSha ? await readPublishedSnapshots(base, blobSha, settings.token) : [];
    // A published file that exists but cannot be read is never overwritten, so a
    // parse problem can never drop an already-published chain.
    if (blobSha && stored === null) continue;
    const merged = mergeSnapshots(stored ?? [], candidate.added);
    // A re-read closing hour that has not changed yet needs no new commit; the
    // cursor already covers it.
    if (blobSha && JSON.stringify(stored) === JSON.stringify(merged)) continue;

    const newest = merged[merged.length - 1];
    files.push({
      path: candidate.path,
      content: JSON.stringify({
        pollId: candidate.pollId,
        // The schema version of the copied chain.
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
        snapshots: merged
      }, null, 2)
    });
    stateUpdates.push({
      pollId: candidate.pollId,
      publishedThrough: snapshotHour(newest),
      final: newest.final === true
    });
  }

  if (files.length === 0) return { pollsUpdated: 0, commitSha: null };

  files.push({
    path: pathFor('index.json'),
    content: JSON.stringify({
      generatedAt: new Date().toISOString(),
      polls: tracked.map((entry) => ({ id: entry.id, topicSlug: entry.topicSlug }))
    }, null, 2)
  });

  const commitSha = await createCommit(
    base,
    settings.branch,
    settings.token,
    head,
    files,
    `Publish snapshots ${isoHour(now)}`
  );
  await savePublishState(env, stateUpdates);
  return { pollsUpdated: stateUpdates.length, commitSha };
}


// Runs one publish pass. It never throws: a skip is reported as `skipped`, and
// any failure is recorded in `publish_runs` and returned as `ok: false` so a
// publish failure can never stop the rest of the maintenance tasks.
export async function runPublisher(
  env: PublisherEnv,
  now = Math.floor(Date.now() / 1000)
): Promise<PublishResult> {
  const startedAt = now;
  try {
    const settings = await readPublishSettings(env);
    if (!settings.enable) {
      return { ok: true, skipped: true, reason: 'publish is disabled', pollsUpdated: 0, commitSha: null };
    }
    if (!settings.token || !settings.repository) {
      return {
        ok: true,
        skipped: true,
        reason: 'publish repository or token is not set',
        pollsUpdated: 0,
        commitSha: null
      };
    }
    const result = await publishOnce(env, settings, now);
    await recordRun(env, startedAt, Math.floor(Date.now() / 1000), result.pollsUpdated, null);
    return { ok: true, skipped: false, pollsUpdated: result.pollsUpdated, commitSha: result.commitSha };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordRun(env, startedAt, Math.floor(Date.now() / 1000), 0, message);
    return { ok: false, skipped: false, pollsUpdated: 0, commitSha: null, error: message };
  }
}

// Reads the configured repository through the GitHub API and reports whether the
// token may write to it.
export async function testGitHubConnection(env: PublisherEnv): Promise<ConnectionTestResult> {
  const settings = await readPublishSettings(env);
  if (!settings.token) {
    return { ok: false, write: false, status: 0, message: 'Set the GitHub token first.' };
  }
  if (!settings.repository || !PUBLISH_REPOSITORY_PATTERN.test(settings.repository)) {
    return { ok: false, write: false, status: 0, message: 'Set the repository as owner/name first.' };
  }
  const [owner, repo] = settings.repository.split('/');
  try {
    const response = await githubRequest(`${GITHUB_API}/repos/${owner}/${repo}`, settings.token);
    if (!response.ok) {
      return {
        ok: false,
        write: false,
        status: response.status,
        message: `GitHub returned ${response.status} for ${settings.repository}.`
      };
    }
    const body = await response.json() as { permissions?: { push?: boolean } };
    const write = body.permissions?.push === true;
    return {
      ok: true,
      write,
      status: response.status,
      message: write
        ? `Write access to ${settings.repository} confirmed.`
        : `The token can read ${settings.repository} but has no write permission.`
    };
  } catch (error) {
    return {
      ok: false,
      write: false,
      status: 0,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export interface PublishRunSummary {
  id: number;
  startedAt: string;
  finishedAt: string;
  pollsUpdated: number;
  error: string | null;
}

interface PublishRunRow {
  id: number;
  started_at: number;
  finished_at: number;
  polls_updated: number;
  error: string | null;
}

// The most recent publisher runs, newest first.
export async function recentPublishRuns(env: PublisherEnv, limit = 5): Promise<PublishRunSummary[]> {
  const result = await env.DB.prepare(
    `SELECT id, started_at, finished_at, polls_updated, error
     FROM publish_runs ORDER BY id DESC LIMIT ?`
  ).bind(limit).all<PublishRunRow>();
  return (result.results ?? []).map((row) => ({
    id: Number(row.id),
    startedAt: new Date(Number(row.started_at) * 1000).toISOString(),
    finishedAt: new Date(Number(row.finished_at) * 1000).toISOString(),
    pollsUpdated: Number(row.polls_updated),
    error: row.error ?? null
  }));
}

// Health summary for /api/health and the admin Overview: the last run time and
// whether the newest run failed.
export async function publishHealth(
  env: PublisherEnv
): Promise<{ lastPublishAt: string | null; publishError: boolean }> {
  try {
    const row = await env.DB.prepare(
      'SELECT finished_at, error FROM publish_runs ORDER BY id DESC LIMIT 1'
    ).first<{ finished_at: number; error: string | null }>();
    if (!row) return { lastPublishAt: null, publishError: false };
    return {
      lastPublishAt: new Date(Number(row.finished_at) * 1000).toISOString(),
      publishError: row.error !== null
    };
  } catch {
    return { lastPublishAt: null, publishError: false };
  }
}

