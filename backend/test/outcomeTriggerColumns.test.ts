/**
 * The append-only trigger reads `signal_outcomes` columns by name, and plpgsql
 * resolves those names at *fire* time.
 *
 * `enforce_outcome_immutability` compares `old.label`, `old.revision` and the
 * graded figure against their `new.` counterparts to decide whether an update
 * is the one permitted kind — retiring a row so a correction can supersede it.
 * Renaming any of those columns does **not** fail the migration and does not
 * fail on the next insert: the function is stored as text and only resolves
 * `old.x` against the record's runtime shape when it actually runs. The first
 * symptom would be `record "old" has no field "..."` on the first attempt to
 * retire a row — which is the path every correction takes, and the one this
 * whole table exists to keep open.
 *
 * That was live in this change: `excursion` became
 * `directional_return_at_horizon` on 2026-09-23, and the rename alone would
 * have left the trigger naming a column that no longer exists. The fix travels
 * in the same migration; this is the guard that the next one has to as well.
 *
 * It is deliberately a *column-level* check on one function rather than a
 * general schema/code column guard. The F-14 class — a migration correct on
 * disk and never applied — is not reachable from here, and a guard that looked
 * like it closed that class while reading only source would be worse than none.
 * What this proves is narrower and true: the SQL in this repo is internally
 * consistent about the names this trigger depends on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SUPABASE = join(__dirname, '..', '..', 'supabase');

/** Every `.sql` under `supabase/`, in the order a setup run applies them. */
function sqlFiles(): string[] {
  const migrations = join(SUPABASE, 'migrations');
  return [
    join(SUPABASE, 'schema.sql'),
    ...readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort()
      .map((f) => join(migrations, f)),
  ];
}

const allSql = () => sqlFiles().map((f) => readFileSync(f, 'utf8'));

/**
 * The columns `signal_outcomes` ends up with: created, then added, then
 * renamed, in file order — the same order a fresh deployment applies them.
 */
function outcomeColumns(): Set<string> {
  const cols = new Set<string>();
  for (const sql of allSql()) {
    const create = /create table if not exists (?:public\.)?signal_outcomes\s*\(([\s\S]*?)\n\);/i
      .exec(sql);
    if (create) {
      for (const line of create[1]!.split('\n')) {
        const m = /^\s{2}([a-z_]+)\s+[a-z]/.exec(line);
        if (m && !/^(constraint|check|primary|unique|foreign)$/.test(m[1]!)) cols.add(m[1]!);
      }
    }
    for (const m of sql.matchAll(
      /alter table (?:public\.)?signal_outcomes\s+add column(?: if not exists)?\s+([a-z_]+)/gi,
    )) cols.add(m[1]!);
    for (const m of sql.matchAll(
      /alter table (?:public\.)?signal_outcomes\s+rename column\s+([a-z_]+)\s+to\s+([a-z_]+)/gi,
    )) {
      // A rename of a column that is not there is how a re-runnable guard
      // reads; only apply it when the source column exists, so this mirrors
      // what Postgres would do rather than inventing a column.
      if (cols.delete(m[1]!)) cols.add(m[2]!);
    }
  }
  assert.ok(cols.size > 10, `parsed only ${cols.size} columns — has the DDL changed shape?`);
  return cols;
}

/** The last definition of the trigger function, which is the one in force. */
function triggerBody(): string {
  let body: string | undefined;
  for (const sql of allSql()) {
    for (const m of sql.matchAll(
      /create or replace function (?:public\.)?enforce_outcome_immutability\(\)[\s\S]*?\n\$\$;/gi,
    )) body = m[0];
  }
  assert.ok(body, 'enforce_outcome_immutability is not defined by any SQL file');
  return body!;
}

test('every column the immutability trigger names still exists after the renames', () => {
  const cols = outcomeColumns();
  const body = triggerBody();

  const named = new Set(
    [...body.matchAll(/\b(?:old|new)\.([a-z_]+)/g)].map((m) => m[1]!),
  );
  assert.ok(named.size >= 4, `found only ${named.size} old./new. references — parse drift?`);

  const missing = [...named].filter((c) => !cols.has(c));
  assert.deepEqual(missing, [],
    `the trigger reads columns signal_outcomes no longer has: ${missing.join(', ')}. ` +
    'plpgsql resolves these at fire time, so this breaks supersession, not the migration.');
});

test('the rename is applied, and the old name survives in no live definition', () => {
  const cols = outcomeColumns();
  assert.ok(cols.has('directional_return_at_horizon'),
    'the graded figure is named for the endpoint it measures');
  assert.ok(!cols.has('excursion'),
    'nothing observes a path here, so no column may be called an excursion');
  assert.ok(!/\b(?:old|new)\.excursion\b/.test(triggerBody()),
    'the trigger was renamed with the column, not after someone hit the failure');
});

test('the trigger function keeps its search_path pinned across the redefinition', () => {
  // `create or replace function` replaces the function's *configuration* along
  // with its body, so a later redefinition silently unpins what an earlier
  // `alter function ... set search_path` pinned. The generic guard in
  // `schemaSetup.test.ts` accepts a pin anywhere; this one requires the pin to
  // be on the definition that is actually last.
  assert.match(triggerBody(), /set\s+search_path\s*=\s*''/,
    'the last definition of the trigger pins its own search_path');
});
