// Fetches the signed snapshot chain for every open poll and every recently
// closed poll and writes it to the data repository as JSON. Run hourly by
// .github/workflows/publish-snapshots.yml so published counts are copied outside
// the operator's database and become tamper-evident.
//
// The script is append-only:
//   * a poll that closed since the last run is still fetched, so its final chain
//     is always copied out;
//   * a chain longer than one API page is followed to the end with `nextAfter`;
//   * new snapshots are appended to the existing poll file, and a poll file is
//     never deleted.
//
// Environment:
//   API_BASE         base URL of the public Worker (for example https://chinapoll.org)
//   DATA_REPO_PATH   checkout directory of the data repository (default: .)

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const apiBase = process.env.API_BASE;
const outputDir = process.env.DATA_REPO_PATH ?? '.';
const PAGE_SIZE = 100;
const CLOSED_DAYS = 35;

if (!apiBase) {
  console.error('API_BASE is not set');
  process.exit(1);
}

async function getJson(path) {
  const response = await fetch(new URL(path, apiBase));
  if (!response.ok) throw new Error(`${path} -> ${response.status}`);
  return response.json();
}

// Lists every currently open poll across all pages.
async function listOpenPolls() {
  const ids = [];
  let page = 1;
  for (;;) {
    const listing = await getJson(`/api/polls?page=${page}&pageSize=${PAGE_SIZE}`);
    for (const entry of listing.polls ?? []) ids.push(entry.poll.id);
    const pageSize = Number(listing.pageSize ?? PAGE_SIZE);
    if (page * pageSize >= Number(listing.total ?? 0)) break;
    page += 1;
  }
  return ids;
}

// Lists polls that closed within the retention window so a poll that closed
// since the last run is fetched again and its final chain is captured.
async function listRecentlyClosed() {
  const listing = await getJson(`/api/polls/recent-closed?days=${CLOSED_DAYS}`);
  return (listing.polls ?? []).map((entry) => entry.id);
}

function snapshotHour(snapshot) {
  return Number(snapshot?.tsHourEpoch ?? 0);
}

// Reads the snapshots already stored for a poll, tolerating a missing or
// unreadable file (a chain is never dropped for a parse error).
async function readStoredSnapshots(pollId) {
  try {
    const parsed = JSON.parse(await readFile(join(outputDir, `${pollId}.json`), 'utf8'));
    return Array.isArray(parsed?.snapshots) ? parsed.snapshots : [];
  } catch {
    return [];
  }
}

// Follows the `nextAfter` cursor until the API reports no more snapshots.
async function fetchNewSnapshots(pollId, after) {
  const added = [];
  let cursor = after;
  for (;;) {
    const chain = await getJson(`/api/snapshots/${pollId}?after=${cursor}`);
    const snapshots = chain.snapshots ?? [];
    added.push(...snapshots);
    if (snapshots.length === 0) break;
    cursor = snapshotHour(snapshots[snapshots.length - 1]);
    if (!chain.hasMore) break;
  }
  return added;
}

// Merges stored and newly fetched snapshots by hour so a re-run cannot duplicate.
function mergeSnapshots(stored, added) {
  const byHour = new Map();
  for (const snapshot of [...stored, ...added]) {
    const hour = snapshotHour(snapshot);
    if (hour > 0) byHour.set(hour, snapshot);
  }
  return [...byHour.entries()].sort((a, b) => a[0] - b[0]).map(([, snapshot]) => snapshot);
}

async function main() {
  const openIds = await listOpenPolls();
  const closedIds = await listRecentlyClosed();
  const pollIds = [...new Set([...openIds, ...closedIds])].sort((a, b) => a - b);

  await mkdir(outputDir, { recursive: true });
  await writeFile(
    join(outputDir, 'index.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), polls: pollIds }, null, 2)
  );

  let updated = 0;
  for (const pollId of pollIds) {
    const stored = await readStoredSnapshots(pollId);
    const lastHour = stored.reduce((highest, snapshot) => Math.max(highest, snapshotHour(snapshot)), 0);
    const added = await fetchNewSnapshots(pollId, lastHour);
    if (added.length === 0) continue;

    const snapshots = mergeSnapshots(stored, added);
    await writeFile(
      join(outputDir, `${pollId}.json`),
      JSON.stringify({ pollId, updatedAt: new Date().toISOString(), snapshots }, null, 2)
    );
    updated += 1;
  }

  console.log(`Updated ${updated} poll file(s); ${pollIds.length} poll(s) tracked.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
