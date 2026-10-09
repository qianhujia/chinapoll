#!/usr/bin/env node

import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { IssueStatus, IssueMode, ProposalStatus } from '../worker/enums.ts';

interface ProposalRow {
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
  console.log('  npm run admin -- approve-proposal <id>');
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

function approveProposal(idText: string | undefined): void {
  if (!idText || !/^[1-9]\d*$/.test(idText)) {
    throw new Error('Usage: npm run admin -- approve-proposal <positive proposal ID>');
  }

  const proposalId = Number(idText);
  if (!Number.isSafeInteger(proposalId)) {
    throw new Error('Proposal ID must be a safe integer.');
  }

  const database = new DatabaseSync(getLocalDatabasePath());
  let transactionStarted = false;
  try {
    database.exec('BEGIN IMMEDIATE');
    transactionStarted = true;

    const proposal = database.prepare(
      `SELECT id, title, description, mode, start_at, end_at, status
       FROM proposals WHERE id = ?`
    ).get(proposalId) as ProposalRow | undefined;

    if (!proposal) throw new Error(`Proposal ${proposalId} was not found.`);
    if (proposal.status !== ProposalStatus.Pending) {
      throw new Error(`Proposal ${proposalId} is not pending approval.`);
    }
    if (proposal.mode !== IssueMode.Deadline && proposal.mode !== IssueMode.Evergreen) {
      throw new Error(`Proposal ${proposalId} has an unsupported mode.`);
    }
    if (!proposal.title?.trim()) {
      throw new Error(`Proposal ${proposalId} has no title.`);
    }

    const result = database.prepare(
      `INSERT INTO issues (title, description, mode, start_at, end_at, status)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      proposal.title,
      proposal.description,
      proposal.mode,
      proposal.start_at,
      proposal.end_at,
      IssueStatus.Open
    );
    const issueId = Number(result.lastInsertRowid);

    const update = database.prepare(
      `UPDATE proposals
       SET status = ?, published_issue_id = ?, reviewed_at = unixepoch(), updated_at = unixepoch()
       WHERE id = ? AND status = ?`
    ).run(ProposalStatus.Approved, issueId, proposalId, ProposalStatus.Pending);

    if (update.changes !== 1) {
      throw new Error(`Proposal ${proposalId} changed before approval could complete.`);
    }

    database.exec('COMMIT');
    transactionStarted = false;
    console.log(`Approved proposal ${proposalId} and created issue ${issueId}.`);
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
