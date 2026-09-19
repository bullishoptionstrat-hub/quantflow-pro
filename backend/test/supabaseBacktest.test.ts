/**
 * The Supabase backtest path, against the wire shapes PostgREST really sends.
 *
 * The in-memory backtest tests prove the selection and honesty rules. This
 * proves the *adapter* — the same two defects `supabaseTrackRecord.test.ts`
 * guards for (numeric columns as strings, `timestamptz` as ISO strings) reach
 * the backtest through the same tally, so they must survive the wire here too —
 * plus the one thing this path does that the track record does not: the string
 * set-membership is applied in process by `matchesScanner`, not in SQL, so a
 * case-insensitive `kinds` filter must still select correctly off raw rows.
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
 * A client that answers the two reads `backtest()` makes: a candidate scan of
 * `signal_history` and a chunked outcome read of `signal_outcomes`. The filter
 * builders (`gte`/`lte`/`eq`) are no-ops here — the store applies the string
 * constraints in process, and the numeric ones are exercised by the in-memory
 * suite — so this stub returns the fixture rows and lets `matchesScanner` do
 * the selecting, which is exactly the wire path.
 */
function stubDb(rows: { signals: unknown[]; outcomes: unknown[] }): SupabaseClient {
  const make = (table: string) => {
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      neq: () => builder,
      gte: () => builder,
      lte: () => builder,
      is: () => builder,
      in: () => builder,
      order: () => builder,
      then: (resolve: (r: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        const reply = table === 'signal_history'
          ? { data: rows.signals, error: null }
          : { data: rows.outcomes, error: null };
        return Promise.resolve(reply).then(resolve, reject);
      },
    };
    return builder;
  };
  return { from: (t: string) => make(t) } as unknown as SupabaseClient;
}

/** A publishable, permitted, observed sample in the shapes PostgREST returns. */
function wireRows(n: number, kind: string, excursion: string) {
  const signals = [];
  const outcomes = [];
  for (let i = 0; i < n; i++) {
    const key = `key-${i}`;
    signals.push({
      signal_key: key,
      kind,
      underlying: 'SPY',
      side: 'BUY',
      total_premium: '250000',   // numeric → string
      total_size: '100',
      score: '82',
      iso: true,
      decision_at: ENTRY,        // timestamptz → ISO string
      synthetic: false,
      decision_basis: 'OBSERVED',
      rights_class: 'PERMITTED',
    });
    outcomes.push({
      signal_key: key,
      horizon: 'M15',
      label: 'POSITIVE',
      excursion,                 // numeric → string
      entry_mark_at: ENTRY,
      exit_mark_at: EXIT,
    });
  }
  return { signals, outcomes };
}

test('a numeric excursion arriving as a string still reaches the published median', async () => {
  const store = new SupabaseSignalStore(stubDb(wireRows(MIN_PUBLISHABLE_SAMPLE, 'SWEEP', '0.023')));
  const r = await store.backtest({});
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0]!.hitRate, 1);
  assert.equal(r.rows[0]!.medianExcursion, 0.023,
    'PostgREST sends numeric as a string; without coercion the excursion vanishes');
});

test('timestamptz stamps arriving as strings still produce a measured interval', async () => {
  const store = new SupabaseSignalStore(stubDb(wireRows(MIN_PUBLISHABLE_SAMPLE, 'SWEEP', '0.01')));
  const r = await store.backtest({});
  const mi = r.rows[0]!.measuredInterval!;
  assert.equal(mi.n, MIN_PUBLISHABLE_SAMPLE);
  assert.equal(mi.nUndated, 0, 'raw ISO strings would read as "no row can say"');
  assert.equal(mi.medianMs, 32 * 60_000);
  assert.equal(mi.nominalMs, 15 * 60_000);
  assert.ok(r.notes.some((n) => /longer interval than the horizon/.test(n)),
    'the disclosure must fire off real wire data');
});

test('a case-insensitive kind filter selects off raw signal rows', async () => {
  // The string constraint is applied in process by matchesScanner, not in SQL.
  // A lowercase filter must still select the uppercase kind the DB stores.
  const store = new SupabaseSignalStore(stubDb(wireRows(MIN_PUBLISHABLE_SAMPLE, 'SWEEP', '0.01')));
  const hit = await store.backtest({ kinds: ['sweep'] });
  assert.equal(hit.matched, MIN_PUBLISHABLE_SAMPLE, 'sweep must match SWEEP');
  assert.equal(hit.rows.length, 1);

  const miss = await store.backtest({ kinds: ['block'] });
  assert.equal(miss.matched, 0, 'block must not match SWEEP');
  assert.match(miss.notes.join(' '), /No signal in the record matched/);
});

test('neither store builds its own backtest arithmetic', () => {
  // The same guard as the track record: both stores reach the tally through the
  // shared module. A store growing its own row/label logic is the drift this
  // check exists to stop.
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  for (const f of ['memoryStore.ts', 'supabaseStore.ts']) {
    const src = readFileSync(join(__dirname, '..', 'src', 'persistence', f), 'utf8');
    assert.match(src, /assembleBacktest\(/, `${f} must assemble the backtest through the shared module`);
    assert.match(src, /matchesScanner\(/, `${f} must select through the shared predicate`);
  }
});
