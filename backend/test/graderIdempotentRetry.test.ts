/**
 * A retry must not turn a recorded checkpoint into a permanent failure, and
 * two ticks must not grade one checkpoint twice.
 *
 * Two ways the same horizon reached the store more than once:
 *
 *   - **The write landed and the reply did not.** A timeout or reset after the
 *     commit throws here although the row exists. The horizon stayed pending,
 *     each retry was refused by the one-live-outcome rule, and the checkpoint
 *     read as a failed write for the life of the process.
 *
 *   - **Ticks overlapped.** `tick()` runs every 60s and awaits each write, so
 *     a slow store let a second tick start while the first was mid-write. Both
 *     graded the same due horizon, at different instants with different exit
 *     marks, and the store kept whichever insert arrived first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySignalStore } from '../src/persistence/memoryStore';
import { SignalGrader, HORIZON_OFFSETS_MS, type Mark } from '../src/persistence/grader';
import type { SignalRecord, OutcomeRecord } from '../src/persistence/types';

const T0 = Date.UTC(2026, 8, 18, 14, 30, 0);

function signal(): SignalRecord {
  return {
    signalKey: 'r'.repeat(64),
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
  } as unknown as SignalRecord;
}

function grader(store: InMemorySignalStore, clock: () => number) {
  return new SignalGrader(
    store,
    (): Mark => ({ price: 101, source: 'twelvedata', rightsClass: 'UNVERIFIED', asOf: clock() }),
    {},
    clock,
  );
}

const M15_DUE = T0 + HORIZON_OFFSETS_MS.M15 + 1_000;

test('a write that commits but reports failure is reconciled, not retried forever', async () => {
  const store = new InMemorySignalStore();
  const real = store.writeOutcome.bind(store);
  let attempts = 0;
  store.writeOutcome = async (rec: OutcomeRecord) => {
    attempts++;
    await real(rec); // the row lands...
    if (attempts === 1) throw new Error('fetch failed: socket hang up'); // ...the reply does not
  };
  const sig = signal();
  await store.writeSignal(sig);

  let now = T0;
  const g = grader(store, () => now);
  g.register(sig);

  now = M15_DUE;
  await g.tick();
  now = M15_DUE + 60_000;
  await g.tick();
  now = M15_DUE + 120_000;
  await g.tick();

  const s = g.getStats();
  assert.equal(attempts, 1, 'the recorded checkpoint is not written again');
  assert.equal(s.writesReconciled, 1, 'the lost reply is counted as reconciled');
  assert.equal(s.writeRetrying, 0, 'and nothing is left owing a row');
  const m15 = (await store.listOutcomes(sig.signalKey)).filter((o) => o.horizon === 'M15');
  assert.equal(m15.length, 1, 'exactly one M15 row');
});

test('a write that genuinely failed is still retried', async () => {
  const store = new InMemorySignalStore();
  const real = store.writeOutcome.bind(store);
  let attempts = 0;
  store.writeOutcome = async (rec: OutcomeRecord) => {
    attempts++;
    if (attempts === 1) throw new Error('relation does not exist');
    return real(rec);
  };
  const sig = signal();
  await store.writeSignal(sig);

  let now = T0;
  const g = grader(store, () => now);
  g.register(sig);
  now = M15_DUE;
  await g.tick();
  assert.equal(g.getStats().writesReconciled, 0, 'no row, so nothing to reconcile');
  assert.equal(g.getStats().writeRetrying, 1);
  now = M15_DUE + 60_000;
  assert.equal(await g.tick(), 1, 'the next tick writes it');
});

test('a failed lookup after a failed write keeps the checkpoint pending', async () => {
  const store = new InMemorySignalStore();
  store.writeOutcome = async () => { throw new Error('connection refused'); };
  const sig = signal();
  await store.writeSignal(sig);
  store.listOutcomes = async () => { throw new Error('connection refused'); };

  let now = T0;
  const g = grader(store, () => now);
  g.register(sig);
  now = M15_DUE;
  await g.tick();
  const s = g.getStats();
  assert.equal(s.writesReconciled, 0, 'an unanswered lookup is not evidence the row exists');
  assert.equal(s.writeRetrying, 1, 'so the checkpoint is still owed');
});

test('a tick that starts while another is running does nothing', async () => {
  const store = new InMemorySignalStore();
  const real = store.writeOutcome.bind(store);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let attempts = 0;
  store.writeOutcome = async (rec: OutcomeRecord) => {
    attempts++;
    await gate; // a slow store
    return real(rec);
  };
  const sig = signal();
  await store.writeSignal(sig);

  let now = T0;
  const g = grader(store, () => now);
  g.register(sig);

  now = M15_DUE;
  const first = g.tick();
  await new Promise((r) => setImmediate(r));
  assert.ok(g.getStats().tickInFlightSince !== undefined, 'the running tick is visible');
  now = M15_DUE + 60_000;
  assert.equal(await g.tick(), 0, 'the overlapping tick returns at once');
  release();
  assert.equal(await first, 1);

  const s = g.getStats();
  assert.equal(attempts, 1, 'the checkpoint was graded once');
  assert.equal(s.ticksSkippedInFlight, 1);
  assert.equal(s.writeFailures, 0, 'no refused duplicate to count as a failure');
  assert.equal(s.tickInFlightSince, undefined, 'cleared once the tick ends');
  const m15 = (await store.listOutcomes(sig.signalKey)).filter((o) => o.horizon === 'M15');
  assert.equal(m15.length, 1);
  assert.equal(m15[0].evaluatedAt, M15_DUE, 'graded at the first tick, not the overlapping one');
});

test('a tick that throws does not leave the grader stuck', async () => {
  const store = new InMemorySignalStore();
  const sig = signal();
  await store.writeSignal(sig);
  let now = T0;
  let throwNow = true;
  const g = new SignalGrader(
    store,
    (): Mark => {
      if (throwNow) throw new Error('mark source blew up');
      return { price: 101, source: 'twelvedata', rightsClass: 'UNVERIFIED', asOf: now };
    },
    {},
    () => now,
  );
  throwNow = false;
  g.register(sig);
  throwNow = true;
  now = M15_DUE;
  await g.tick().catch(() => undefined);
  throwNow = false;
  assert.equal(g.getStats().tickInFlightSince, undefined);
  now = M15_DUE + 60_000;
  await g.tick();
  assert.equal(g.getStats().ticksSkippedInFlight, 0, 'the next tick ran rather than being skipped');
});
