/**
 * The documented setup sequence aborted, and took the grader's four tables
 * with it.
 *
 * README step 3 and CLAUDE.md both insist on the same order, and on both
 * halves: run `supabase/schema.sql`, **and then** every file in
 * `supabase/migrations/` in filename order. That instruction is the fix for an
 * earlier defect — `schema.sql` creates none of the four tables the recorder
 * and grader write to, so naming it alone left them uncreated.
 *
 * Followed literally, on a real PostgreSQL 17, the instruction did this:
 *
 *     ok    supabase/schema.sql
 *     ABORT 20240707000000_initial_schema.sql
 *           ERROR: policy "user_profiles_select_own" for table
 *                  "user_profiles" already exists            (SQLSTATE 42710)
 *
 *     tables the grader writes: (none)
 *
 * `schema.sql` and the initial migration are one DDL in two homes, held to
 * agreement on purpose by `schemaSetup.test.ts`. That agreement is exactly
 * what breaks the sequence: all nineteen policy names are in both files, and
 * PostgreSQL has no `create policy if not exists`. The first migration dies on
 * its first policy, and `signal_history`, `signal_outcomes`,
 * `signal_write_incidents` and `collection_gaps` — which live in the *second*
 * migration — are never reached.
 *
 * So the previous fix produced the same end state it was written to prevent: a
 * database with the seven application tables, none of the four research ones,
 * and an operator who followed the instructions.
 *
 * The rule this test holds is the general one rather than that instance:
 * **every object the SQL creates must be created in a way that survives being
 * run twice.** Not because re-running is the normal path, but because it is
 * what an operator does after an error, and because the live project's
 * `supabase_migrations.schema_migrations` records versions that do not match
 * these filenames — measured 2026-09-21, five of six differ — so a
 * disk-driven push would offer to apply five already-applied files.
 *
 * Idempotency is one of a small set of shapes, and the test names which:
 * `if not exists` for tables, indexes and columns; `or replace` for functions
 * and triggers; a preceding `drop policy if exists` for policies, which have
 * no other form; and an existence check against `pg_constraint` for
 * constraints, which is what `mark_source` and `mark_as_of` already do.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SUPABASE = join(__dirname, '..', '..', 'supabase');

/** `schema.sql` plus every migration — the whole documented sequence. */
function sequence(): { name: string; sql: string }[] {
  const migrations = readdirSync(join(SUPABASE, 'migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ name: `migrations/${f}`, sql: readFileSync(join(SUPABASE, 'migrations', f), 'utf8') }));
  return [
    { name: 'schema.sql', sql: readFileSync(join(SUPABASE, 'schema.sql'), 'utf8') },
    ...migrations,
  ];
}

/**
 * Comments carry SQL in this repo — `revoke_handle_new_user.sql` explains
 * itself with the phrase "CREATE TRIGGER" in prose — so a scanner that reads
 * them finds statements that do not exist.
 */
function executable(sql: string): string {
  return sql
    .split('\n')
    .filter((l) => !/^\s*--/.test(l))
    .join('\n');
}

test('every table, index and column is created only if it is absent', () => {
  for (const { name, sql } of sequence()) {
    const body = executable(sql);
    for (const m of body.matchAll(/^create (?:unique )?(table|index)\s+(?!if not exists)(\S+)/gim)) {
      assert.fail(`${name}: \`create ${m[1]} ${m[2]}\` is not guarded by \`if not exists\` — `
        + 'a second run of the documented sequence would abort here');
    }
    for (const m of body.matchAll(/add column\s+(?!if not exists)(\S+)/gi)) {
      assert.fail(`${name}: \`add column ${m[1]}\` is not guarded by \`if not exists\``);
    }
  }
});

test('every function and trigger either replaces or drops its own name first', () => {
  // Two shapes are idempotent and both are in this tree: `create or replace`,
  // and a preceding `drop ... if exists` — which is what
  // `20260829120000_signal_history.sql` uses for `trg_outcome_immutability`,
  // and it is correct. The rule is the property, not one spelling of it.
  for (const { name, sql } of sequence()) {
    const lines = executable(sql).split('\n');
    lines.forEach((line, i) => {
      const m = /^create (function|trigger)\s+([^\s(]+)/i.exec(line);
      if (!m) return;
      const [, kind, object] = m;
      const before = lines.slice(Math.max(0, i - 3), i).join('\n');
      const dropped = new RegExp(`drop ${kind} if exists ${object!.replace('.', '\\.')}\\b`, 'i');
      assert.ok(dropped.test(before),
        `${name}: \`create ${kind} ${object}\` would abort on a second run — `
        + `write \`create or replace ${kind}\`, or drop it first as `
        + 'signal_history.sql does for trg_outcome_immutability');
    });
  }
});

test('every policy drops its own name before creating it', () => {
  // `create policy` has no `if not exists` and no `or replace` in any shipped
  // PostgreSQL, so the drop is the only available shape. Dropping first is
  // fail-closed: RLS is enabled on all of these tables, and a table with RLS
  // and no policy denies by default, so the gap between the two statements
  // refuses rather than admits.
  for (const { name, sql } of sequence()) {
    const body = executable(sql);
    const lines = body.split('\n');
    lines.forEach((line, i) => {
      const m = /^create policy "([^"]+)" on (\S+)/.exec(line);
      if (!m) return;
      const [, policy, table] = m;
      const before = lines.slice(Math.max(0, i - 3), i).join('\n');
      const guard = new RegExp(`drop policy if exists "${policy}" on ${table.replace('.', '\\.')}`, 'i');
      assert.ok(guard.test(before),
        `${name}: \`create policy "${policy}" on ${table}\` is not preceded by `
        + `\`drop policy if exists "${policy}" on ${table};\` — a second run aborts with `
        + '42710 and every statement after it never runs');
    });
  }
});

test('every constraint is added behind a pg_constraint existence check', () => {
  for (const { name, sql } of sequence()) {
    const body = executable(sql);
    for (const m of body.matchAll(/add constraint\s+(\S+)/gi)) {
      const constraint = m[1]!.replace(/[^a-z_0-9]/gi, '');
      const guard = new RegExp(`from pg_constraint where conname = '${constraint}'`, 'i');
      assert.ok(guard.test(body),
        `${name}: \`add constraint ${constraint}\` has no `
        + `\`select 1 from pg_constraint where conname = '${constraint}'\` guard — `
        + 'this is the shape mark_source.sql and mark_as_of.sql already use');
    }
  }
});

test('the nineteen policy names really are in both homes', () => {
  // The premise of the defect, asserted so it cannot quietly stop being true:
  // if the two files ever stop sharing policy names, the sequence stops
  // colliding and the guards above are protecting nothing.
  const names = (sql: string) =>
    [...executable(sql).matchAll(/^create policy "([^"]+)"/gm)].map((m) => m[1]).sort();

  const schema = names(readFileSync(join(SUPABASE, 'schema.sql'), 'utf8'));
  const initial = names(readFileSync(
    join(SUPABASE, 'migrations', '20240707000000_initial_schema.sql'), 'utf8'));

  assert.ok(schema.length > 0, 'premise: schema.sql defines policies');
  assert.deepEqual(schema, initial,
    'schema.sql and the initial migration disagree about which policies exist');
});
