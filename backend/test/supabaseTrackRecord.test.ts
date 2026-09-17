/**
 * The Supabase track-record path, against the wire shapes PostgREST really sends.
 *
 * This path had no test. The shared tally is unit-tested with numeric
 * timestamps and numeric excursions handed in directly, and the only existing
 * Supabase test exits inside the count query long before the outcome mapping
 * runs — so the adapter between PostgREST's JSON and the tally was covered by
 * nothing, in the store that is the entire point of having durable history.
 *
 * Two real defects were sitting in that gap:
 *
 *   1. `numeric` columns arrive as **strings**. Postgres `numeric` is
 *      arbitrary-precision and a JSON number is a float64, so PostgREST sends
 *      `"0.023"`. `toRecord` had always coerced (`Number(d.score)`); the
 *      outcome read path never did, and when `trackRecord`'s excursion
 *      handling moved into a shared tally that gates on `typeof === 'number'`,
 *      every Supabase-backed row would have published a `hitRate` with
 *      `medianExcursion` silently gone.
 *   2. `timestamptz` columns arrive as ISO strings, so the mark stamps need
 *      `Date.parse` before an interval can be computed from them. Handed
 *      through raw they fail the same typeof gate and every row reports as
 *      undated — the disclosure reading as "no row can say", rather than as
 *      the wrong number, which is the quieter of the two failures.
 *
 * A fixture in the wire's own types is the only thing that catches either.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseSignalStore } from '../src/persistence/supabaseStore';
import { MIN_PUBLISHABLE_SAMPLE } from '../src/persistence/types';

const ENTRY = '2026-09-17T14:00:00.000Z';
/** 32 minutes later: an M15 row measured over twice its horizon. */
const EXIT = '2026-09-17T14:32:00.000Z';

/**
 * A client narrow enough to reach `trackRecord()` and no narrower.
 *
 * `select('*', { count: 'exact', head: true })` is a count; anything else is a
 * data read, answered from the table it was asked of. That is exactly the
 * branch `count()` and the two scans take.
 */
function stubDb(rows: { signals: unknown[]; outcomes: unknown[] }): SupabaseClient {
  const make = (table: string) => {
    let isCount = false;
    const builder: any = {
      select: (_cols: string, opts?: { head?: boolean }) => {
        if (opts?.head) isCount = true;
        return builder;
      },
      eq: () => builder,
      neq: () => builder,
      is: () => builder,
      in: () => builder,
      order: () => builder,
      then: (resolve: (r: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        const reply = isCount
          ? { count: 0, error: null }
          : table === 'signal_history'
            ? { data: rows.signals, error: null }
            : { data: rows.outcomes, error: null };
        return Promise.resolve(reply).then(resolve, reject);
      },
    };
    return builder;
  };
  return { from: (t: string) => make(t) } as unknown as SupabaseClient;
}

/** A publishable sample, in the shapes PostgREST actually returns. */
function wireRows(n: number, excursion: string) {
  const signals = [];
  const outcomes = [];
  for (let i = 0; i < n; i++) {
    const key = `key-${i}`;
    signals.push({ signal_key: key, kind: 'SWEEP' });
    outcomes.push({
      signal_key: key,
      horizon: 'M15',
      label: 'POSITIVE',
      excursion,                 // numeric  → string
      entry_mark_at: ENTRY,      // timestamptz → ISO string
      exit_mark_at: EXIT,
    });
  }
  return { signals, outcomes };
}

test('a numeric column arriving as a string still reaches the published median', async () => {
  const store = new SupabaseSignalStore(
    stubDb(wireRows(MIN_PUBLISHABLE_SAMPLE, '0.023')),
  );
  const report = await store.trackRecord();

  assert.equal(report.rows.length, 1);
  const row = report.rows[0]!;
  assert.equal(row.nGraded, MIN_PUBLISHABLE_SAMPLE);
  assert.equal(row.hitRate, 1);
  assert.equal(row.medianExcursion, 0.023,
    'PostgREST sends `numeric` as a string; without coercion this row publishes ' +
    'a hit rate with no excursion beside it and nothing says why');
});

test('timestamptz stamps arriving as strings still produce a measured interval', async () => {
  const store = new SupabaseSignalStore(
    stubDb(wireRows(MIN_PUBLISHABLE_SAMPLE, '0.01')),
  );
  const report = await store.trackRecord();

  const mi = report.rows[0]!.measuredInterval!;
  assert.ok(mi, 'the interval must survive the wire, not just the unit test');
  assert.equal(mi.n, MIN_PUBLISHABLE_SAMPLE);
  assert.equal(mi.nUndated, 0,
    'raw ISO strings would fail the typeof gate and read as "no row can say"');
  assert.equal(mi.medianMs, 32 * 60_000);
  assert.equal(mi.nominalMs, 15 * 60_000);

  const note = report.notes.find((n) => /longer interval than the horizon/.test(n));
  assert.ok(note, 'and the disclosure must fire off real wire data, not only in unit tests');
  assert.match(note, /median 32min/);
});

test('a blank numeric is absent, not zero', async () => {
  // `Number('')` is 0. An excursion of exactly zero is a FLAT reading and a
  // real measurement; a blank column is the absence of one, and the two must
  // not arrive at the same published number.
  const store = new SupabaseSignalStore(
    stubDb(wireRows(MIN_PUBLISHABLE_SAMPLE, '')),
  );
  const report = await store.trackRecord();
  assert.equal(report.rows[0]!.medianExcursion, undefined,
    'a blank must not publish as a 0.00% median excursion');
  assert.equal(report.rows[0]!.hitRate, 1, 'the rate itself is unaffected');
});

test('the outcome read path coerces every numeric column it maps', () => {
  // `excursion`, `entry_mark` and `exit_mark` are all `numeric`, and all three
  // were mapped with `?? undefined` — strings behind a type declaring `number`.
  // Nothing had ever compared one against a number, which is why three of them
  // survived until a `typeof` gate arrived.
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  const src = readFileSync(
    join(__dirname, '..', 'src', 'persistence', 'supabaseStore.ts'), 'utf8');
  for (const col of ['r.excursion', 'r.entry_mark', 'r.exit_mark']) {
    assert.match(src, new RegExp(`num\\(${col.replace('.', '\\.')}\\)`),
      `${col} is a numeric column and must be coerced, not passed through`);
  }
  assert.ok(!/(excursion|entry_mark|exit_mark)\s*\?\?\s*undefined/.test(src),
    'a `?? undefined` on a numeric column leaves a string behind a number type');
});
