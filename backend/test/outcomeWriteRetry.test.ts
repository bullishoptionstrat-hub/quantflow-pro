/**
 * A checkpoint whose write fails must not be discarded. (INV-009)
 *
 * `tick()` deleted the horizon from `remaining` *outside* the try that wrapped
 * `writeOutcome`, so a checkpoint whose write threw was dropped in the same
 * breath as one that succeeded: no row, no retry, and not one counter moved.
 * The only trace was `lastError`, which holds the most recent message only and
 * is scrubbed from the unauthenticated `/api/health`.
 *
 * That made a store refusing every write indistinguishable — on every number
 * the health payload publishes — from a deployment with nothing to grade. It
 * was reachable in production, not hypothetically: the live Supabase project
 * was missing `entry_mark_at`/`exit_mark_at` until 2026-09-21, so every insert
 * would have failed `42703`, and the counters would have read all zeros while
 * every gradable outcome was thrown away.
 *
 * The first test is the reproduction kept as a guard — it drives a store that
 * fails once and asserts the row still lands — because a premise you cannot
 * watch fail is not a premise.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InMemorySignalStore } from '../src/persistence/memoryStore';
import { SignalGrader, HORIZON_OFFSETS_MS, type Mark } from '../src/persistence/grader';
import type { SignalRecord, OutcomeRecord } from '../src/persistence/types';

const T0 = Date.UTC(2026, 8, 18, 14, 30, 0);

function signal(over: Partial<SignalRecord> = {}): SignalRecord {
  return {
    signalKey: 'k'.repeat(64),
    engineId: 'sig_1_1',
    underlying: 'SPY',
    kind: 'SWEEP',
    side: 'BUY',
    score: 80,
    totalPremium: 1_000_000,
    totalSize: 500,
    firstEventAt: T0 - 1_000,
    lastEventAt: T0 - 500,
    receivedAt: T0,
    decisionAt: T0,
    decisionBasis: 'OBSERVED',
    source: 'tradier',
    datasetId: 'TRADIER_STREAM',
    rightsClass: 'PERMITTED',
    synthetic: false,
    legs: [{
      underlying: 'SPY', expiry: '2026-12-18', strike: 550, right: 'C',
      side: 'BUY', totalSize: 500, totalPremium: 1_000_000, prints: 2,
    }],
    printIds: ['p1', 'p2'],
    ...over,
  } as SignalRecord;
}

/**
 * A store whose `writeOutcome` refuses the first `failures` calls.
 *
 * The message is the real one the live database produced before the mark-as-of
 * migration was applied, rather than a stand-in: this test exists because that
 * exact failure was silent.
 */
function flakyStore(failures: number) {
  const store = new InMemorySignalStore();
  const real = store.writeOutcome.bind(store);
  let attempts = 0;
  store.writeOutcome = async (rec: OutcomeRecord) => {
    attempts++;
    if (attempts <= failures) {
      throw new Error(
        'signal_outcomes insert failed: column "entry_mark_at" of relation ' +
          '"signal_outcomes" does not exist',
      );
    }
    return real(rec);
  };
  return { store, attempts: () => attempts };
}

function graderAt(store: InMemorySignalStore, clock: () => number, price = 101) {
  const mark: Mark = { price, source: 'twelvedata', rightsClass: 'UNVERIFIED', asOf: 0 };
  return new SignalGrader(
    store,
    () => ({ ...mark, asOf: clock() }),
    {},
    clock,
  );
}

test('a failed outcome write leaves the checkpoint pending, and the next tick writes it', async () => {
  const { store, attempts } = flakyStore(1);
  const sig = signal();
  await store.writeSignal(sig);

  let now = T0;
  const g = graderAt(store, () => now);
  g.register(sig);

  now = T0 + HORIZON_OFFSETS_MS.M15 + 1_000;
  assert.equal(await g.tick(), 0, 'the failing tick writes nothing');
  assert.equal(
    (await store.listOutcomes(sig.signalKey)).filter((o) => o.horizon === 'M15').length,
    0,
    'and lands no row',
  );

  now = T0 + HORIZON_OFFSETS_MS.M15 + 120_000;
  assert.equal(await g.tick(), 1, 'the next tick retries the same checkpoint');

  const m15 = (await store.listOutcomes(sig.signalKey)).filter((o) => o.horizon === 'M15');
  assert.equal(m15.length, 1, 'the M15 row exists after the retry');
  assert.equal(m15[0].label, 'FLAT', 'and carries the grade it always would have');
  assert.equal(attempts(), 2, 'exactly one retry, not a storm');
});

test('the failure is counted, so an all-failing store is not mistaken for a quiet one', async () => {
  const { store } = flakyStore(Number.MAX_SAFE_INTEGER);
  const sig = signal();
  await store.writeSignal(sig);

  let now = T0;
  const g = graderAt(store, () => now);
  g.register(sig);

  now = T0 + HORIZON_OFFSETS_MS.M15 + 1_000;
  await g.tick();
  await g.tick();
  await g.tick();

  const s = g.getStats();
  assert.equal(s.graded, 0);
  assert.equal(s.ungraded, 0);
  assert.equal(s.flat, 0);
  // Every counter above reads the same on a deployment with nothing to grade.
  // This is the one that does not.
  assert.equal(s.writeFailures, 3, 'one failure counted per refused attempt');
  assert.equal(s.writeRetrying, 1, 'the overdue M15 checkpoint is still owed a row');
  assert.equal(s.tracked, 1, 'and the signal is still tracked, not dropped');
});

test('a grader with nothing due reports no failures and nothing retrying', async () => {
  const store = new InMemorySignalStore();
  const sig = signal();
  await store.writeSignal(sig);

  let now = T0;
  const g = graderAt(store, () => now);
  g.register(sig);

  now = T0 + 60_000; // well inside M15
  assert.equal(await g.tick(), 0);

  const s = g.getStats();
  assert.equal(s.writeFailures, 0, 'quiet is not failing');
  assert.equal(s.writeRetrying, 0, 'and nothing is overdue');
});

test('the success path still retires the horizon and drops the completed signal', async () => {
  const store = new InMemorySignalStore();
  const sig = signal();
  await store.writeSignal(sig);

  let now = T0;
  const g = graderAt(store, () => now);
  g.register(sig);

  now = T0 + HORIZON_OFFSETS_MS.D1 + 1_000;
  const written = await g.tick();
  assert.equal(written, 3, 'M15, H1 and D1 all came due');

  const s = g.getStats();
  assert.equal(s.writeFailures, 0);
  assert.equal(s.writeRetrying, 0);
  assert.equal(s.tracked, 0, 'a fully graded signal leaves `pending`');

  // A second tick must not rewrite what is already recorded.
  assert.equal(await g.tick(), 0);
  assert.equal((await store.listOutcomes(sig.signalKey)).length, 3);
});

test('the health scrub drops only `lastError`, so the new counters stay public', () => {
  const src = readFileSync(
    join(__dirname, '..', 'src', 'ingestion', 'index.ts'),
    'utf8',
  );
  const scrub = /const scrub = [\s\S]{0,400}?\n  };/.exec(src);
  assert.ok(scrub, 'the scrub helper is still in index.ts under that name');
  const body = scrub[0];
  assert.match(body, /lastError: _dropped, \.\.\.counters/, 'it still spreads the rest');
  // If a second field is ever destructured out, it leaves the health payload
  // silently — which is how `writeFailures` would stop being readable.
  const dropped = body.match(/const \{([^}]*)\} = s;/);
  assert.ok(dropped, 'the destructure is still there to read');
  const names = dropped[1].split(',').map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(
    names.filter((n) => !n.startsWith('...')),
    ['lastError: _dropped'],
    'exactly one field is stripped from the grader/recorder stats',
  );
});

test('`tick` does not retire a horizon on the failure path', () => {
  // The defect was positional: the `delete` sat after the catch rather than
  // inside the success path, so no assertion about *outcomes* could see it —
  // the row is missing either way on the tick that fails. Position is what
  // changed, so position is what is held.
  const src = readFileSync(
    join(__dirname, '..', 'src', 'persistence', 'grader.ts'),
    'utf8',
  );
  const tick = /async tick\(\)[\s\S]*?\n  \}/.exec(src);
  assert.ok(tick, 'tick() is still a method by that name');
  const body = tick[0];
  const catchAt = body.indexOf('} catch (err) {');
  const deleteAt = body.indexOf('p.remaining.delete(horizon);');
  assert.ok(catchAt >= 0 && deleteAt >= 0, 'both landmarks are present');
  const between = body.slice(catchAt, deleteAt);
  assert.match(
    between,
    /\n\s*continue;\n/,
    'the catch block leaves the iteration before the delete can run',
  );
  assert.match(between, /writeFailures\+\+/, 'and counts the failure on the way out');
});
