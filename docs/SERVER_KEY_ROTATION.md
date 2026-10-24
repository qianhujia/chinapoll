# Rotating SERVER_HMAC_KEY while preserving owner hashes

This procedure rotates `SERVER_HMAC_KEY` and keeps every existing poll and comment
attributable to its author. It applies to one specific case: **the old key is
known** (for example, a value that was committed to the repository or stored where
it could be read).

The general rotation in [RUNBOOK.md](RUNBOOK.md#key-rotation) is simpler but
permanently unclaims all existing content. Use this procedure when you can and
want to avoid that.

All commands are run from the repository root.

## Background

`SERVER_HMAC_KEY` is the HMAC master key behind two things:

- the keyed, daily-rotated network hashes in `auth_attempts`
  (`hashedNetworkBucket` in `worker/services/ip.ts`), and
- the poll and comment ownership hashes (`ownerHash`, `commentOwnerHash` in
  `worker/services/owner.ts`).

The ownership hash is a one-way HMAC over a message that names its subject:

```
polls.owner_hash    = HMAC(deriveKey(master, "owner"), "owner:<userId>:<pollId>")
comments.owner_hash = HMAC(deriveKey(master, "owner"), "owner:<userId>:comment:<publicId>")
```

`polls` and `comments` store only the hash, never the author id. A new key
produces a different hash for every row, so "My polls" and "My comments" go empty
and close, withdraw, and delete refuse, even for the original author.

## Why this procedure can preserve ownership

The author id is not stored, but it is not secret either: `users.id` is a small
auto-increment integer. When the old key is known, the author of each row can be
recovered by trying every `userId` until the computed hash matches the stored one.
The hash is then recomputed with the new key. This is possible only because the
old key is known; with an unknown old key there is no recovery, and the plain
rotation applies.

## What changes and what does not

- `polls.owner_hash` / `comments.owner_hash` are re-hashed, so ownership is
  preserved. Rows whose `owner_hash IS NULL` (legacy rows written before owners
  existed, or written without a key) are skipped and stay unclaimable.
- `auth_attempts.ip_hash` is not migrated. The old daily sub-keys simply stop
  matching, which relaxes the rolling per-network account cap for one day.
- Everything else is untouched.
- Only the public Worker reads the secret; the admin Worker never references
  `SERVER_HMAC_KEY`.

## Prerequisites

- The old key (64 hex characters).
- A new key: `openssl rand -hex 32`. Save it in a password manager or vault before
  continuing; Cloudflare never shows a stored secret again, and the value is needed
  again for account failover.
- Node 22 and an authenticated `npx wrangler` for the production account.
- This is a data change, not a schema change: no file is added under `migrations/`.

## Procedure

Re-hash **before** flipping the secret, so there is no window in which owners lose
access.

### 1. Export the rows

```sh
npx wrangler d1 execute chinapoll --env production --remote --json \
  --command "SELECT id, owner_hash FROM polls WHERE owner_hash IS NOT NULL" > polls.json

npx wrangler d1 execute chinapoll --env production --remote --json \
  --command "SELECT public_id, owner_hash FROM comments WHERE owner_hash IS NOT NULL" > comments.json

npx wrangler d1 execute chinapoll --env production --remote --json \
  --command "SELECT id FROM users" > users.json
```

Each file is a JSON array whose first element has a `results` member.

### 2. Recover and re-hash offline

Run the script below with the exported files, the old key, and the new key. It
reproduces the exact derivation used by the Worker: `deriveKey(master, "owner")`
is `HMAC-SHA256(fromHex(master), "owner")`, and the row hash is
`HMAC-SHA256(ownerKey, message)` in lowercase hex.

```js
// rotate-owner-key.mjs - one-off. Reads the exports from step 1 and writes
// rotation.sql. Node 22.
import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [pollsFile, commentsFile, usersFile, oldKey, newKey, outFile] = process.argv.slice(2);

const hexToBytes = (hex) => Buffer.from(hex, 'hex');
const hmacHex = (key, message) => createHmac('sha256', key).update(message, 'utf8').digest('hex');
const ownerKey = (masterHex) => hexToBytes(hmacHex(hexToBytes(masterHex), 'owner'));
const rowHash = (masterHex, userId, subject) =>
  hmacHex(ownerKey(masterHex), `owner:${userId}:${subject}`);

const results = (file) => JSON.parse(readFileSync(file, 'utf8'))[0].results;
const userIds = results(usersFile).map((row) => Number(row.id));

const recover = (stored, subject, label) => {
  for (const userId of userIds) {
    if (rowHash(oldKey, userId, subject) === stored) return userId;
  }
  throw new Error(`no user matched ${label}; is the old key correct?`);
};

const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
const statements = [];

for (const row of results(pollsFile)) {
  const userId = recover(row.owner_hash, `${row.id}`, `poll ${row.id}`);
  statements.push(
    `UPDATE polls SET owner_hash = ${quote(rowHash(newKey, userId, `${row.id}`))} WHERE id = ${Number(row.id)};`
  );
}

for (const row of results(commentsFile)) {
  const userId = recover(row.owner_hash, `comment:${row.public_id}`, `comment ${row.public_id}`);
  statements.push(
    `UPDATE comments SET owner_hash = ${quote(rowHash(newKey, userId, `comment:${row.public_id}`))} WHERE public_id = ${quote(row.public_id)};`
  );
}

writeFileSync(outFile, statements.join('\n') + '\n');
console.log(`${statements.length} statements written to ${outFile}`);
```

Keep the derivation in step with `shared/crypto.ts` and
`worker/services/owner.ts`; this script mirrors them.

### 3. Rehearse on a local copy

```sh
npx wrangler d1 export chinapoll --env production --remote --output backup.sql
npx wrangler d1 execute chinapoll-local --local --file backup.sql
```

Run the script against the local rows and confirm the statement count equals the
number of owner rows exported in step 1.

### 4. Apply the statements

```sh
npx wrangler d1 execute chinapoll --env production --remote --file rotation.sql
```

### 5. Flip the secret

```sh
npx wrangler secret put SERVER_HMAC_KEY --env production
```

No redeploy is needed; the secret takes effect for the running Worker.

### 6. Verify

- `GET /api/health` reports `"serverKey": true`.
- Sign in as an account that owns polls and comments and confirm they still list,
  and that close, withdraw, and delete still work.
- `SELECT COUNT(*) FROM polls WHERE owner_hash IS NOT NULL` is unchanged.

## Troubleshooting

- **No user matched a row.** The old key is not the value that wrote that row. If
  production never used the leaked value, there is nothing to preserve; use the
  plain rotation in [RUNBOOK.md](RUNBOOK.md#key-rotation). If only some rows fail,
  those rows predate owners or were written under an even older key; decide per row
  whether to leave them unclaimable.
- **`503` responses after rotation.** The secret was uploaded under the wrong name
  or is malformed: `isValidServerKey` requires exactly 64 hex characters.
  `GET /api/health` reports `"serverKey": false`.
- **The account cap behaves loosely for a day.** Expected. The old `auth_attempts`
  hashes no longer match, so the cap relaxes until those rows age out.

## After rotation

- Store the new key in a password manager or vault; account failover needs the same
  value (see [RUNBOOK.md](RUNBOOK.md#migrating-to-another-cloudflare-account)).
- Change the local `.dev.vars` value so it differs from the committed test fixture.
- Never reuse the old value anywhere.
- The fixture value in `vitest.workers.config.ts` and the tests is only a test
  value; after this rotation it is inert in production.

## Related documentation

- [RUNBOOK.md](RUNBOOK.md) - deployments, key rotation, and failover.
- [DATA_MAP.md](DATA_MAP.md) - how `owner_hash` and network hashes are stored.
- [THREAT_MODEL.md](THREAT_MODEL.md) - what each key protects.
