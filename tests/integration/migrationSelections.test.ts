// Migration 0004 data copy.
//
// The delicate part of the 0004 rebuild is the copy: a verdict poll becomes a
// single choice poll with three labeled rows, an old verdict ballot's answer
// becomes one selection, and every other table that references `polls` must keep
// its rows across the parent swap. This test reproduces the pre-0004 shape and
// then applies 0004 on top of it, so a mistake in the copy is caught by a real
// database.
//
// The other integration test files apply every migration to an empty database
// (see `applySchema`), which is the "no ballots" case 0004 must also handle.

import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { MIGRATIONS, runMigrationSql } from './helpers';

describe('migration 0004', () => {
  it('turns a verdict poll into a single choice poll and removes votes.option', async () => {
    // Migrations 0001 to 0003 build the old shape: poll_type 1 is the verdict
    // poll, `votes.option` carries its answer, and only choice polls have option
    // rows.
    for (const migration of MIGRATIONS.slice(0, 3)) await runMigrationSql(migration.sql);

    await env.DB.batch([
      env.DB.prepare("INSERT INTO polls (id, title, description, mode, status, poll_type) VALUES (1, 'Verdict', 'd', 2, 1, 1)"),
      env.DB.prepare("INSERT INTO polls (id, title, description, mode, status, poll_type) VALUES (2, 'Choice', 'd', 2, 1, 2)"),
      env.DB.prepare("INSERT INTO poll_options (id, poll_id, position, label) VALUES (10, 2, 1, 'Bus')"),
      env.DB.prepare("INSERT INTO poll_options (id, poll_id, position, label) VALUES (11, 2, 2, 'Metro')"),
      // Old codes: 1 approve, 2 oppose, 3 neutral, NULL for a choice ballot.
      env.DB.prepare("INSERT INTO votes (id, poll_id, voter_token_hash, option, created_at) VALUES (100, 1, 'a', 1, 1)"),
      env.DB.prepare("INSERT INTO votes (id, poll_id, voter_token_hash, option, created_at) VALUES (101, 1, 'b', 2, 1)"),
      env.DB.prepare("INSERT INTO votes (id, poll_id, voter_token_hash, option, created_at) VALUES (102, 1, 'c', 3, 1)"),
      env.DB.prepare("INSERT INTO votes (id, poll_id, voter_token_hash, option, created_at) VALUES (103, 2, 'd', NULL, 1)"),
      env.DB.prepare('INSERT INTO vote_selections (vote_id, option_id) VALUES (103, 11)'),
      // Every other table that references `polls` must survive the rebuild.
      env.DB.prepare("INSERT INTO comments (id, poll_id, comment, public_id, created_at) VALUES (5, 1, 'hello', 'pub', 1)"),
      env.DB.prepare('INSERT INTO poll_reports (id, poll_id, reason, created_at) VALUES (7, 1, 1, 1)'),
      env.DB.prepare('INSERT INTO poll_views (poll_id, ts_day, views) VALUES (1, 86400, 3)'),
      env.DB.prepare(`INSERT INTO stats_snapshots
        (poll_id, ts_hour, approve, oppose, neutral, ballots, option_counts, views, prev_hash, hash, final)
        VALUES (1, 1000, 1, 2, 3, 6, '[{"position":1,"count":3}]', 4, 'GENESIS', 'hash-v2', 0)`),
      env.DB.prepare(`INSERT INTO stats_snapshots
        (poll_id, ts_hour, approve, oppose, neutral, views, prev_hash, hash, final)
        VALUES (2, 1000, 0, 0, 0, 9, 'GENESIS', 'hash-v1', 1)`)
    ]);

    await runMigrationSql(MIGRATIONS[3].sql);

    // The verdict poll is now a single choice poll with three labeled rows.
    const polls = await env.DB.prepare('SELECT id, poll_type FROM polls ORDER BY id ASC').all();
    expect(polls.results).toEqual([
      { id: 1, poll_type: 2 },
      { id: 2, poll_type: 2 }
    ]);

    const options = await env.DB.prepare(
      'SELECT poll_id, position, label FROM poll_options ORDER BY poll_id ASC, position ASC'
    ).all();
    expect(options.results).toEqual([
      { poll_id: 1, position: 1, label: 'Approve' },
      { poll_id: 1, position: 2, label: 'Neutral' },
      { poll_id: 1, position: 3, label: 'Oppose' },
      { poll_id: 2, position: 1, label: 'Bus' },
      { poll_id: 2, position: 2, label: 'Metro' }
    ]);

    // One selection per ballot: old code 1 -> Approve, 2 -> Oppose, 3 -> Neutral,
    // and the choice selection keeps its option id.
    const selections = await env.DB.prepare(
      `SELECT vs.poll_id, vs.vote_id, o.label
       FROM vote_selections vs
       JOIN poll_options o ON o.id = vs.option_id
       ORDER BY vs.vote_id ASC`
    ).all();
    expect(selections.results).toEqual([
      { poll_id: 1, vote_id: 100, label: 'Approve' },
      { poll_id: 1, vote_id: 101, label: 'Oppose' },
      { poll_id: 1, vote_id: 102, label: 'Neutral' },
      { poll_id: 2, vote_id: 103, label: 'Metro' }
    ]);

    // The copied choice selection still points at the option row it always did.
    const kept = await env.DB.prepare(
      `SELECT o.id, o.position FROM vote_selections vs
       JOIN poll_options o ON o.id = vs.option_id
       WHERE vs.vote_id = 103`
    ).first<{ id: number; position: number }>();
    expect(Number(kept?.id)).toBe(11);
    expect(Number(kept?.position)).toBe(2);

    // The ballot table holds no choice data any more.
    const columns = await env.DB.prepare("SELECT name FROM pragma_table_info('votes')").all<{ name: string }>();
    expect(columns.results?.map((row) => row.name)).toEqual(['id', 'poll_id', 'voter_token_hash', 'created_at']);

    // The old unique index survives, the old per-option index does not.
    const indexes = await env.DB.prepare("SELECT name FROM pragma_index_list('votes')").all<{ name: string }>();
    const names = (indexes.results ?? []).map((row) => row.name).sort();
    expect(names).toEqual(['idx_votes_poll_id', 'idx_votes_poll_voter_token']);

    // Every other child of `polls` kept its rows across the parent swap.
    const counts: Record<string, number> = {};
    for (const table of ['comments', 'poll_reports', 'poll_views', 'stats_snapshots', 'poll_options', 'votes']) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS total FROM ${table}`).first<{ total: number }>();
      counts[table] = Number(row?.total ?? 0);
    }
    expect(counts).toEqual({
      comments: 1,
      poll_reports: 1,
      poll_views: 1,
      stats_snapshots: 2,
      poll_options: 5,
      votes: 4
    });

    // A stored snapshot keeps its counts and its hash, and a new one may leave
    // the verdict columns out entirely.
    const snapshot = await env.DB.prepare(
      'SELECT approve, oppose, neutral, ballots, option_counts, hash FROM stats_snapshots WHERE poll_id = 1'
    ).first<{
      approve: number; oppose: number; neutral: number;
      ballots: number; option_counts: string; hash: string;
    }>();
    expect(snapshot).toMatchObject({
      approve: 1, oppose: 2, neutral: 3, ballots: 6, hash: 'hash-v2'
    });
    await env.DB.prepare(
      "INSERT INTO stats_snapshots (poll_id, ts_hour, ballots, views, prev_hash, hash) VALUES (1, 2000, 2, 1, 'x', 'y')"
    ).run();

    // The narrowed CHECK rejects the removed verdict type.
    await expect(runMigrationSql(
      "INSERT INTO polls (title, mode, status, poll_type) VALUES ('Verdict again', 2, 1, 1)"
    )).rejects.toThrow();

    // Every copied selection references a real ballot, option, and poll.
    const violations = await env.DB.prepare('SELECT * FROM pragma_foreign_key_check').all();
    expect(violations.results).toEqual([]);
  });
});
