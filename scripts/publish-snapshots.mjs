// Fetches the signed snapshot chain for every open poll and writes it to the
// data repository as JSON. Run hourly by
// .github/workflows/publish-snapshots.yml so published counts are copied outside
// the operator's database and become tamper-evident.
//
// Environment:
//   API_BASE         base URL of the public Worker (for example https://chinapoll.org)
//   DATA_REPO_PATH   checkout directory of the data repository (default: .)

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const apiBase = process.env.API_BASE;
const outputDir = process.env.DATA_REPO_PATH ?? '.';
if (!apiBase) {
  console.error('API_BASE is not set');
  process.exit(1);
}

async function getJson(path) {
  const response = await fetch(new URL(path, apiBase));
  if (!response.ok) throw new Error(`${path} -> ${response.status}`);
  return response.json();
}

async function main() {
  const pollIds = [];
  let page = 1;
  for (;;) {
    const listing = await getJson(`/api/polls?page=${page}&pageSize=100`);
    for (const entry of listing.polls ?? []) pollIds.push(entry.poll.id);
    const pageSize = Number(listing.pageSize ?? 100);
    if (page * pageSize >= Number(listing.total ?? 0)) break;
    page += 1;
  }

  await mkdir(outputDir, { recursive: true });
  await writeFile(
    join(outputDir, 'index.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), polls: pollIds }, null, 2)
  );

  for (const pollId of pollIds) {
    const chain = await getJson(`/api/snapshots/${pollId}`);
    await writeFile(join(outputDir, `${pollId}.json`), JSON.stringify(chain, null, 2));
  }

  console.log(`Wrote snapshots for ${pollIds.length} polls.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});