/**
 * A restart must not permanently lose an eligible outcome. (INV-009)
 *
 * `SignalGrader.pending` is process memory. Every checkpoint scheduled before
 * a restart used to be abandoned in silence: the row stayed in
 * `signal_history`, no outcome was ever written, and nothing looked again.
 * `listUngraded()` existed in both stores and on the interface, was exercised
 * by two tests, and was called by nothing in `src/`.
 *
 * The first test here is the reproduction, kept as a guard: it drives the
 * *unrecovered* path and asserts the loss, because a premise you cannot watch
 * fail is not a premise. The rest hold the recovery to the properties that
 * make it honest rather than merely productive.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InMemorySignalStore } from '../src/persistence/memoryStore';
import { SignalGrader, recoverEntryMark, type Mark } from '../src/persistence/grader';
import { GRADED_HORIZONS, type SignalRecord } from '../src/persistence/types';
import { DEFAULT_GRADER_CONFIG, HORIZON_OFFSETS_MS } from '../src/persistence/grader';

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

/** A mark source that always answers, stamped at a caller-controlled instant. */
function markAt(stamp: () => number, price = 100): (u: string) => Mark {
  return () => ({ price, source: 'twelvedata', rightsClass: 'UNVERIFIED', asOf: stamp() });
}

const RIGHTS = (src: string) => (src === 'twelvedata' ? 'UNVERIFIED' : undefined);

test('the reproduction: without recovery a restart loses the checkpoint', async () => {
  const store = new InMemorySignalStore();
  const rec = signal();
  await store.writeSignal(rec);

  let clock = T0;
  const graderA = new SignalGrader(store, markAt(() => clock - 1_000), {}, () => clock);
  graderA.register(rec);
  assert.equal(graderA.getStats().tracked, 1);

  // Restart: graderA is discarded, the store survives — exactly what durable
  // storage buys, and exactly what the grader's memory does not.
  const graderB = new SignalGrader(store, markAt(() => clock - 1_000), {}, () => clock);
  assert.equal(graderB.getStats().tracked, 0, 'a fresh grader knows nothing');

  clock = T0 + 15 * 60_000 + 5_000; // M15 falls due
  assert.equal(await graderB.tick(), 0, 'nothing is graded');
  assert.equal((await store.listOutcomes(rec.signalKey)).length, 0);
});

test('recovery resumes the checkpoint and grades it exactly once', async () => {
  const store = new InMemorySignalStore();
  const rec = signal();
  await store.writeSignal(rec);

  let clock = T0;
  // Lifetime 1 grades M15, which is what persists an entry mark.
  const graderA = new SignalGrader(store, markAt(() => clock - 1_000), {}, () => clock);
  graderA.register(rec);
  clock = T0 + 15 * 60_000 + 5_000;
  assert.equal(await graderA.tick(), 1);

  // Restart before H1.
  const graderB = new SignalGrader(store, markAt(() => clock - 1_000), {}, () => clock);
  const report = await graderB.recover(500, RIGHTS);

  assert.equal(report.examined, 1);
  assert.equal(report.resumed, 1);
  assert.equal(report.alreadyComplete, 0);
  assert.equal(report.withEntryMark, 1, 'the entry mark came back off the M15 row');

  clock = T0 + 60 * 60_000 + 5_000; // H1 falls due
  assert.equal(await graderB.tick(), 1, 'H1 graded after the restart');

  const outs = await store.listOutcomes(rec.signalKey);
  const horizons = outs.map((o) => o.horizon).sort();
  assert.deepEqual(horizons, ['H1', 'M15'], 'M15 was not graded a second time');
});

test('a signal graded at every horizon is not resumed again', async () => {
  const store = new InMemorySignalStore();
  const rec = signal();
  await store.writeSignal(rec);

  let clock = T0;
  const graderA = new SignalGrader(store, markAt(() => clock - 1_000), {}, () => clock);
  graderA.register(rec);
  clock = T0 + 24 * 60 * 60_000 + 5_000; // every horizon due at once
  await graderA.tick();
  assert.equal((await store.listOutcomes(rec.signalKey)).length, GRADED_HORIZONS.length);

  const graderB = new SignalGrader(store, markAt(() => clock - 1_000), {}, () => clock);
  const report = await graderB.recover(500, RIGHTS);
  // The store's own filter already excludes it, so recovery never even sees
  // it: `examined` is 0, not `alreadyComplete` 1. That branch in `recover` is
  // the belt to the store's braces — it catches a store whose filter disagrees
  // rather than trusting every implementation to agree forever.
  assert.equal(report.examined, 0, 'a finished signal is not even offered');
  assert.equal(report.resumed, 0, 'and is not rescheduled');
  assert.equal(await graderB.tick(), 0, 'and writes no duplicate outcome row');
  assert.equal((await store.listOutcomes(rec.signalKey)).length, GRADED_HORIZONS.length);
});

test('a resumed signal with no observed entry mark grades UNGRADED, not from a fresh price', async () => {
  // The dangerous alternative: take a mark *now*. For a signal from hours ago
  // that is a price from long after the decision, and it would produce a
  // confident, wrong measurement instead of a visible gap.
  const store = new InMemorySignalStore();
  const rec = signal();
  await store.writeSignal(rec);

  // Restart before anything was ever graded, so no entry mark was persisted.
  let clock = T0 + 20 * 60_000;
  const grader = new SignalGrader(store, markAt(() => clock), {}, () => clock);
  const report = await grader.recover(500, RIGHTS);
  assert.equal(report.resumed, 1);
  assert.equal(report.withEntryMark, 0, 'there was no mark to recover');

  assert.equal(await grader.tick(), 1);
  const outs = await store.listOutcomes(rec.signalKey);
  const m15 = outs.find((o) => o.horizon === 'M15')!;
  assert.equal(m15.label, 'UNGRADED');
  assert.equal(m15.directionalReturnAtHorizon, undefined, 'no excursion was invented');
  assert.match(m15.ungradedReason!, /entry mark/i);
  // The row must carry NO entry mark at all. Asserting only the UNGRADED label
  // is too weak: a recovery that wrongly took a fresh price would still be
  // refused here — by the lookahead guard, because this fixture's restart is
  // 20 minutes late — and the test would pass for the wrong reason. It is the
  // absence of the mark that says recovery never reached for one.
  assert.equal(m15.entryMark, undefined, 'no mark was taken at recovery time');
  assert.equal(m15.entryMarkSource, undefined);
});

test('recovery inside the lookahead tolerance still refuses to take a fresh mark', async () => {
  // The case the test above cannot see. Here the restart is only 30s after the
  // decision, so a freshly-taken mark would sit INSIDE
  // `maxEntryMarkLookaheadMs` and grade cleanly — producing a confident
  // measurement from a price the signal itself may already have moved. Nothing
  // downstream could tell that row from an honest one.
  const store = new InMemorySignalStore();
  const rec = signal();
  await store.writeSignal(rec);

  let clock = T0 + 30_000;
  const grader = new SignalGrader(store, markAt(() => clock, 500), {}, () => clock);
  const report = await grader.recover(500, RIGHTS);
  assert.equal(report.resumed, 1);
  assert.equal(report.withEntryMark, 0);

  clock = T0 + 15 * 60_000 + 5_000;
  assert.equal(await grader.tick(), 1);
  const m15 = (await store.listOutcomes(rec.signalKey))[0]!;
  assert.equal(m15.label, 'UNGRADED',
    'a mark from after the decision must not become a graded outcome');
  assert.equal(m15.entryMark, undefined, 'and must not be recorded as the entry');
});

test('an entry mark stamped after the decision is refused as lookahead', async () => {
  const store = new InMemorySignalStore();
  const rec = signal();
  await store.writeSignal(rec);

  let clock = T0;
  // Stamped ten minutes AFTER the decision instant — well past the tolerance
  // for registration latency. Only the too-early direction used to be guarded,
  // because the age is a subtraction and a mark from the future makes it
  // negative.
  const grader = new SignalGrader(store, markAt(() => T0 + 10 * 60_000), {}, () => clock);
  grader.register(rec);

  clock = T0 + 15 * 60_000 + 5_000;
  assert.equal(await grader.tick(), 1);
  const m15 = (await store.listOutcomes(rec.signalKey))[0]!;
  assert.equal(m15.label, 'UNGRADED');
  assert.match(m15.ungradedReason!, /AFTER the decision/);
});

test('recoverEntryMark refuses a mark whose rights class cannot be named', () => {
  const row = {
    entryMark: 100, entryMarkSource: 'some-retired-vendor', entryMarkAt: T0 - 1_000,
  };
  assert.equal(recoverEntryMark([row], RIGHTS), undefined,
    'an unregistered source yields no mark rather than a placeholder class');
  assert.deepEqual(
    recoverEntryMark([{ ...row, entryMarkSource: 'twelvedata' }], RIGHTS),
    { price: 100, source: 'twelvedata', rightsClass: 'UNVERIFIED', asOf: T0 - 1_000 },
  );
  // A row with no stamp cannot date the mark, so it is not usable either.
  assert.equal(
    recoverEntryMark([{ entryMark: 100, entryMarkSource: 'twelvedata' }], RIGHTS),
    undefined,
  );
});

test('listUngraded drains once every graded horizon is written', async () => {
  // It counted against 4 — the size of the OutcomeHorizon union, which
  // includes the never-graded EXPIRY — so the set could never empty and
  // recovery would have re-registered finished signals on every boot.
  const store = new InMemorySignalStore();
  const rec = signal();
  await store.writeSignal(rec);
  assert.equal((await store.listUngraded(10)).length, 1);

  for (const horizon of GRADED_HORIZONS) {
    await store.writeOutcome({
      signalKey: rec.signalKey, horizon, label: 'FLAT', directionalReturnAtHorizon: 0,
      dueAt: T0, evaluatedAt: T0, revision: 1,
    });
  }
  assert.equal((await store.listUngraded(10)).length, 0, 'the open set drains');
});

/**
 * The wiring, asserted from source.
 *
 * `listUngraded()` was implemented in both stores, declared on the interface
 * and exercised by two tests — and called by nothing in `src/`. Every test
 * above would have passed in exactly that state. This is the one that would
 * not: it is the difference between a recovery that exists and a recovery that
 * runs, which is the distinction this repository keeps rediscovering.
 */
test('startup actually calls recovery, and before the first tick is scheduled', () => {
  const src = readFileSync(
    join(__dirname, '..', 'src', 'ingestion', 'index.ts'), 'utf8',
  );

  const start = src.indexOf('function startSignalHistory');
  assert.ok(start > 0, 'startSignalHistory still exists');
  const body = src.slice(start);

  const recoverAt = body.indexOf('grader.recover(');
  assert.ok(recoverAt > 0,
    'startSignalHistory must call grader.recover() — without it a restart ' +
    'abandons every pending checkpoint in silence');

  // Recovery has to be requested before the grading timer starts, or the first
  // tick runs against an empty schedule and the resumed signals wait a full
  // minute for a checkpoint that may already be past its lateness tolerance.
  const tickAt = body.indexOf('grader?.tick()');
  assert.ok(tickAt > 0, 'the grading tick is still here');
  assert.ok(recoverAt < tickAt, 'recovery is requested before the tick loop');

  // The rights resolver is passed rather than defaulted: the default refuses
  // every mark, which would silently make every resumed signal UNGRADED.
  assert.match(body.slice(recoverAt, recoverAt + 200), /markRightsClass/,
    'recovery is given a rights resolver for recovered marks');
});

test('recovery asks for a window, and the window is derived from the horizons', async () => {
  // Without a window the Supabase scan reads the oldest rows and filters
  // afterwards, so a fully-graded prefix hides every pending signal and
  // recovery resumes nothing while reporting `examined: 0`. Measured against
  // that store: 2,000 graded signals ahead of 100 pending ones returned 0.
  //
  // This asserts the grader actually asks for one, and that the bound is the
  // longest horizon plus the lateness tolerance rather than a number somebody
  // chose — a signal older than that has no checkpoint left that could produce
  // anything but UNGRADED.
  const store = new InMemorySignalStore();
  let asked: number | undefined;
  let sawLimit = 0;
  const spy = {
    ...store,
    listUngraded: async (limit: number, sinceMs?: number) => {
      sawLimit = limit;
      asked = sinceMs;
      return [];
    },
    listOutcomes: store.listOutcomes.bind(store),
  } as unknown as InMemorySignalStore;

  const clock = T0 + 10 * 24 * 60 * 60_000;
  const grader = new SignalGrader(spy, markAt(() => clock), {}, () => clock);
  await grader.recover(250, RIGHTS);

  assert.equal(sawLimit, 250, 'the caller\'s limit is passed through');
  assert.ok(asked !== undefined, 'recovery must bound its scan by a window');
  assert.equal(
    clock - asked,
    HORIZON_OFFSETS_MS.D1 + DEFAULT_GRADER_CONFIG.maxLatenessMs,
    'the window is the longest horizon plus the lateness tolerance',
  );
});

test('the in-memory store honours the same window', async () => {
  // The two stores must answer the same question, or the fixture against one
  // proves nothing about the other — which is how `listUngraded` came to be
  // covered by two tests and still shipped a scan that returned nothing.
  const store = new InMemorySignalStore();
  await store.writeSignal(signal({ signalKey: 'a'.repeat(64), decisionAt: T0 }));
  await store.writeSignal(signal({
    signalKey: 'b'.repeat(64),
    decisionAt: T0 - 40 * 24 * 60 * 60_000,
  }));

  const all = await store.listUngraded(10);
  assert.equal(all.length, 2, 'no window means everything');

  const recent = await store.listUngraded(10, T0 - 24 * 60 * 60_000);
  assert.deepEqual(recent.map((r) => r.signalKey), ['a'.repeat(64)],
    'the signal decided forty days ago is outside the window');
});
