#!/usr/bin/env node

import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { IssueStatus, IssueMode } from '../worker/enums.ts';
import { DEFAULT_PUBLIC_SETTINGS } from '../worker/api/settings.ts';

interface PendingIssueRow {
  id: number;
  title: string | null;
  description: string | null;
  mode: number;
  start_at: number | null;
  end_at: number | null;
  status: number;
}

function showHelp(): void {
  console.log('ChinaPoll admin CLI');
  console.log('Usage:');
  console.log('  npm run admin -- initialize-settings');
  console.log('  npm run admin -- approve-proposal <issue-id>');
  console.log('  npm run admin -- audit-proposal <id>');
  console.log('  npm run admin -- publish-issue <id>');
  console.log('  npm run admin -- finalize <issueId>');
  console.log('  npm run admin -- readonly on|off');
}

function getLocalDatabasePath(): string {
  const databaseDirectory = join(
    process.cwd(),
    '.wrangler',
    'v3',
    'd1',
    'miniflare-D1DatabaseObject'
  );
  const databaseFiles = readdirSync(databaseDirectory)
    .filter((name) => /^[a-f0-9]+\.sqlite$/.test(name));

  if (databaseFiles.length !== 1) {
    throw new Error(`Expected one local D1 database in ${databaseDirectory}, found ${databaseFiles.length}.`);
  }

  return join(databaseDirectory, databaseFiles[0]);
}

function initializeSettings(): void {
  const database = new DatabaseSync(getLocalDatabasePath());
  let transactionStarted = false;
  try {
    database.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    const insert = database.prepare(
      'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
    );
    let inserted = 0;
    for (const [key, value] of Object.entries(DEFAULT_PUBLIC_SETTINGS)) {
      inserted += Number(insert.run(key, String(value)).changes);
    }
    database.exec('COMMIT');
    transactionStarted = false;
    console.log(`Initialized ${inserted} missing public settings.`);
  } catch (error) {
    if (transactionStarted) {
      try {
        database.exec('ROLLBACK');
      } catch (rollbackError) {
        console.error('Failed to roll back settings initialization:', rollbackError);
      }
    }
    throw error;
  } finally {
    database.close();
  }
}

function approveProposal(idText: string | undefined): void {
  if (!idText || !/^[1-9]\d*$/.test(idText)) {
    throw new Error('Usage: npm run admin -- approve-proposal <positive issue ID>');
  }

  const issueId = Number(idText);
  if (!Number.isSafeInteger(issueId)) {
    throw new Error('Issue ID must be a safe integer.');
  }

  const database = new DatabaseSync(getLocalDatabasePath());
  let transactionStarted = false;
  try {
    database.exec('BEGIN IMMEDIATE');
    transactionStarted = true;

    const proposal = database.prepare(
      `SELECT id, title, description, mode, start_at, end_at, status
       FROM issues WHERE id = ?`
    ).get(issueId) as PendingIssueRow | undefined;

    if (!proposal) throw new Error(`Pending issue ${issueId} was not found.`);
    if (proposal.status !== IssueStatus.Pending) {
      throw new Error(`Issue ${issueId} is not pending approval.`);
    }
    if (proposal.mode !== IssueMode.Deadline && proposal.mode !== IssueMode.Evergreen) {
      throw new Error(`Issue ${issueId} has an unsupported mode.`);
    }
    if (!proposal.title?.trim()) {
      throw new Error(`Issue ${issueId} has no title.`);
    }

    const update = database.prepare(
      `UPDATE issues
       SET status = ?, reviewed_at = unixepoch(), updated_at = unixepoch()
       WHERE id = ? AND status = ?`
    ).run(IssueStatus.Open, issueId, IssueStatus.Pending);

    if (update.changes !== 1) {
      throw new Error(`Issue ${issueId} changed before approval could complete.`);
    }

    database.exec('COMMIT');
    transactionStarted = false;
    console.log(`Approved submission; issue ID ${issueId} is now open.`);
  } catch (error) {
    if (transactionStarted) {
      try {
        database.exec('ROLLBACK');
      } catch (rollbackError) {
        console.error('Failed to roll back proposal approval:', rollbackError);
      }
    }
    throw error;
  } finally {
    database.close();
  }
}

const [command = 'help', argument] = process.argv.slice(2);

try {
  switch (command) {
    case 'initialize-settings':
      initializeSettings();
      break;
    case 'approve-proposal':
      approveProposal(argument);
      break;
    case 'audit-proposal':
      console.log(`Audit proposal ${argument ?? 'unknown'} with rule set: 1, 2, 3, 4, 5`);
      break;
    case 'publish-issue':
      console.log(`Publish issue ${argument ?? 'unknown'} to the public feed.`);
      break;
    case 'finalize':
      console.log(`Finalize issue ${argument ?? 'unknown'} and export CSV snapshot.`);
      break;
    case 'readonly':
      console.log(`Readonly flag set to ${argument ?? 'off'}`);
      break;
    case 'help':
      showHelp();
      break;
    default:
      showHelp();
      throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
