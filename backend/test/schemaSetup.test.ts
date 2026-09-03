/**
 * The setup instructions named one file, and the code writes to tables that
 * are in a different one.
 *
 * README step 3 and CLAUDE.md both said "run `supabase/schema.sql`", and
 * `schema.sql` describes itself as the source of truth. It creates seven
 * application tables — `user_profiles`, `api_keys`, `watchlist`,
 * `saved_filters`, `power_alerts`, `price_history`, `flow_archive` — and not
 * one of the four the recorder and grader actually use.
 *
 * Those live in `migrations/20260829120000_signal_history.sql`. So a
 * deployment that followed the documented setup had a database where **every
 * signal write failed**, `/api/track-record` reported nothing forever, and
 * `collection:doctor` pointed at credentials and a hosting horizon rather than
 * at four missing tables.
 *
 * This test makes the instruction checkable: every table the code reads must
 * be created by a file the setup path names.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const SUPABASE = join(ROOT, 'supabase');
const STORE = join(__dirname, '..', 'src', 'persistence', 'supabaseStore.ts');

/** Every table the store addresses, resolved through its `T_*` constants. */
function tablesUsedByCode(): string[] {
  const src = readFileSync(STORE, 'utf8');
  const consts = new Map<string, string>();
  for (const m of src.matchAll(/^const (T_\w+) = '([a-z_]+)';/gm)) {
    consts.set(m[1]!, m[2]!);
  }
  const used = new Set<string>();
  for (const m of src.matchAll(/\.from\((T_\w+)\)/g)) {
    const name = consts.get(m[1]!);
    assert.ok(name, `${m[1]} is used but not defined`);
    used.add(name!);
  }
  assert.ok(used.size > 0, 'no tables found — has the store changed shape?');
  return [...used].sort();
}

/** Tables created by a SQL file. */
function tablesCreatedBy(path: string): Set<string> {
  const sql = readFileSync(path, 'utf8');
  return new Set(
    [...sql.matchAll(/create table if not exists (?:public\.)?(\w+)/gi)].map((m) => m[1]!),
  );
}

const migrations = () =>
  readdirSync(join(SUPABASE, 'migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => join(SUPABASE, 'migrations', f));

test('every table the code writes to is created by the documented setup', () => {
  const created = new Set<string>();
  for (const f of [join(SUPABASE, 'schema.sql'), ...migrations()]) {
    for (const t of tablesCreatedBy(f)) created.add(t);
  }
  const missing = tablesUsedByCode().filter((t) => !created.has(t));
  assert.deepEqual(missing, [],
    `no SQL in supabase/ creates: ${missing.join(', ')}`);
});

test('the setup instructions name every file that setup needs', () => {
  // Naming `schema.sql` alone left the signal-history tables uncreated, and
  // the failure is invisible: the recorder logs a write error per signal and
  // the track record simply stays empty.
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const claude = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');

  const schemaOnly = tablesCreatedBy(join(SUPABASE, 'schema.sql'));
  const needsMigrations = tablesUsedByCode().some((t) => !schemaOnly.has(t));
  assert.ok(needsMigrations, 'premise: the store needs a table schema.sql does not create');

  for (const [name, doc] of [['README.md', readme], ['CLAUDE.md', claude]] as const) {
    assert.match(doc, /supabase\/migrations/,
      `${name} tells you to run schema.sql but not the migrations that carry the history tables`);
  }
});

test('schema.sql and the initial migration do not drift', () => {
  // They define the same seven tables — one DDL in two homes, which is the
  // defect this repo keeps closing, in SQL. Held to agreement rather than
  // collapsed, because `schema.sql` is run by hand and what is deployed
  // cannot be verified from the repo.
  const initial = migrations().find((f) => f.includes('initial_schema'));
  assert.ok(initial, 'expected an initial_schema migration');
  assert.deepEqual(
    [...tablesCreatedBy(join(SUPABASE, 'schema.sql'))].sort(),
    [...tablesCreatedBy(initial!)].sort(),
    'schema.sql and the initial migration disagree about which tables exist',
  );
});
