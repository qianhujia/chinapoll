// Migration 0004 data copy.
//
// The delicate part of the 0004 rebuild is the copy: a choice selection keeps its
// `option_id`, and a verdict ballot's old `option` code becomes one selection on
// the poll's preset row. This test reproduces the pre-0004 shape and then applies
// 0004 on top of it, so a mistake in the copy is caught by a real database.
//
// The other integration test files apply every migration to an empty database
// (see `applySchema`), which is the "no ballots" case 0004 must also handle.

import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { MIGRATIONS, runMigrationSql } from './helpers';

describe('migration 0004', () => {
  it('maps old ballots onto selections and removes votes.option', async () => {
    // Migrations 0001 to 0003 build the old shape: votes carry a verdict code and
    // only choice polls have option rows.
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
      env.DB.prepare('INSERT INTO vote_selections (vote_id, option_id) VALUES (103, 11)')
    ]);

    await runMigrationSql(MIGRATIONS[3].sql);

    // Every verdict poll now carries the three preset rows; the choice poll keeps
    // its labeled rows with their ids.
    const options = await env.DB.prepare(
      'SELECT poll_id, position, label, preset_key FROM poll_options ORDER BY poll_id ASC, position ASC'
    ).all();
    expect(options.results).toEqual([
      { poll_id: 1, position: 1, label: null, preset_key: 'approve' },
      { poll_id: 1, position: 2, label: null, preset_key: 'oppose' },
      { poll_id: 1, position: 3, label: null, preset_key: 'neutral' },
      { poll_id: 2, position: 1, label: 'Bus', preset_key: null },
      { poll_id: 2, position: 2, label: 'Metro', preset_key: null }
    ]);

    // One selection per ballot: the old verdict code resolves to its preset row
    // and the choice selection keeps its option id.
    const selections = await env.DB.prepare(
      `SELECT vs.poll_id, vs.vote_id, o.preset_key, o.label
       FROM vote_selections vs
       JOIN poll_options o ON o.id = vs.option_id
       ORDER BY vs.vote_id ASC`
    ).all();
    expect(selections.results).toEqual([
      { poll_id: 1, vote_id: 100, preset_key: 'approve', label: null },
      { poll_id: 1, vote_id: 101, preset_key: 'oppose', label: null },
      { poll_id: 1, vote_id: 102, preset_key: 'neutral', label: null },
      { poll_id: 2, vote_id: 103, preset_key: null, label: 'Metro' }
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

    // Every copied selection references a real ballot, option, and poll.
    const violations = await env.DB.prepare('SELECT * FROM pragma_foreign_key_check').all();
    expect(violations.results).toEqual([]);
  });
});
