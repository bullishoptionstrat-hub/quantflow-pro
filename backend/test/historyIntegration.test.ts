/**
 * End-to-end: a print enters `ingestPrint`, and a durable record comes out the
 * other side with an observed decision time and correct provenance.
 *
 * The unit tests prove each piece. This one proves they are actually wired
 * together — the failure mode being guarded against is a subsystem that is
 * fully correct and simply never called, which is precisely the state the
 * OutcomeTracker was in before this change.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ingestPrint, drainIdle, onSignal, __clearSignalObservers,
  type RawPrint,
} from '../src/ingestion/flowEngineAdapter';
import { InMemorySignalStore } from '../src/persistence/memoryStore';
import { SignalRecorder } from '../src/persistence/recorder';
import { SignalGrader } from '../src/persistence/grader';
import type { SignalOrigin } from '../src/ingestion/flowEngineAdapter';
import type { ClassifiedSignal } from '../src/flow-engine/types';

function print(over: Partial<RawPrint> = {}): RawPrint {
  return {
    symbol: 'SPY',
    expiry: '2026-09-19',
    strike: 550,
    right: 'C',
    price: 25,
    size: 200,
    // Two venues make it a sweep, and give the engine a reason to cluster.
    exchanges: ['CBOE', 'PHLX'],
    bid: 24.9,
    ask: 25.1,
    openInterest: 1_000,
    underlyingPrice: 548,
    source: 'tradier',
    ...over,
  };
}

/**
 * Collect the signals the adapter publishes for ONE underlying.
 *
 * The adapter holds a single module-level engine, so an unfinalized burst from
 * an earlier test can close during a later one. Each test therefore uses its
 * own symbol and reads only its own signals — otherwise these tests would pass
 * or fail depending on the order they ran in.
 */
function capture(underlying: string) {
  const signals: Array<{ sig: ClassifiedSignal; origin: SignalOrigin }> = [];
  onSignal((sig, origin) => {
    if (sig.underlying === underlying) signals.push({ sig, origin });
  });
  return signals;
}

/**
 * Feed a cluster and force it closed.
 *
 * The engine finalizes a burst when a later trade advances the watermark past
 * the sweep window, so a second print on a different strike, comfortably past
 * that window, closes the first one deterministically.
 */
function feedCluster(base: Partial<RawPrint>, baseTs: number): void {
  ingestPrint(print({ ...base, id: `${base.symbol}-a`, ts: baseTs, price: 25.1 }));
  ingestPrint(print({ ...base, id: `${base.symbol}-b`, ts: baseTs + 5_000, strike: 600 }));
  ingestPrint(print({ ...base, id: `${base.symbol}-c`, ts: baseTs + 10_000, strike: 610 }));
}

test('a real print becomes a durable record with an OBSERVED decision time', async (t) => {
  __clearSignalObservers();
  t.after(() => __clearSignalObservers());

  const store = new InMemorySignalStore();
  const recorder = new SignalRecorder(store, 'PRIVATE_RESEARCH');
  const signals = capture('SPY');

  const before = Date.now();
  feedCluster({ symbol: 'SPY', source: 'tradier' }, before);

  assert.ok(signals.length > 0, 'the adapter published at least one signal');
  for (const { sig, origin } of signals) await recorder.record(sig, origin);

  const counts = await store.countSignals();
  assert.ok(counts.real > 0, 'a real (non-synthetic) signal was recorded');
  assert.equal(counts.synthetic, 0);

  // Every recorded row carries a measured decision time, not the first print's.
  const open = await store.listUngraded(50);
  assert.ok(open.length > 0);
  for (const rec of open) {
    assert.equal(rec.decisionBasis, 'OBSERVED', 'receipt time was threaded through');
    assert.equal(rec.rightsClass, 'PERMITTED');
    assert.equal(rec.datasetId, 'TRADIER_STREAM');
    assert.ok(rec.decisionAt >= rec.lastEventAt);
    assert.ok(rec.lastEventAt >= rec.firstEventAt);
    assert.ok(rec.decisionAt >= before);
    assert.match(rec.signalKey, /^[0-9a-f]{64}$/);
  }
});

test('an unverified source produces signals on the wire but nothing in the record', async (t) => {
  // The intended split: CBOE data still reaches the UI (display is a separate
  // capability), but it does not accumulate into a permanent database.
  __clearSignalObservers();
  t.after(() => __clearSignalObservers());

  const store = new InMemorySignalStore();
  const recorder = new SignalRecorder(store, 'PRIVATE_RESEARCH');
  const signals = capture('QQQ');

  feedCluster({ symbol: 'QQQ', source: 'cboe_options' }, Date.now());

  assert.ok(signals.length > 0, 'the signal was still classified and emitted');
  for (const { sig, origin } of signals) {
    assert.equal((await recorder.record(sig, origin)).status, 'REFUSED_RIGHTS');
  }

  assert.equal((await store.countSignals()).total, 0, 'and nothing was persisted');
  assert.ok(recorder.getStats().refusedRights > 0);
});

test('the grader picks up a recorded real signal and grades it at M15', async (t) => {
  __clearSignalObservers();
  t.after(() => __clearSignalObservers());

  const store = new InMemorySignalStore();
  const recorder = new SignalRecorder(store, 'PRIVATE_RESEARCH');
  const signals = capture('IWM');

  feedCluster({ symbol: 'IWM', source: 'tradier' }, Date.now());

  const keys: string[] = [];
  for (const { sig, origin } of signals) {
    const res = await recorder.record(sig, origin);
    if (res.status === 'RECORDED') keys.push(res.signalKey!);
  }
  assert.ok(keys.length > 0);

  // Drive the clock and the spot feed directly.
  let spot = 548;
  let now = Date.now();
  const grader = new SignalGrader(store, () => spot, {}, () => now);

  for (const k of keys) {
    const rec = await store.getSignal(k);
    if (rec) grader.register(rec);
  }
  assert.ok(grader.getStats().tracked > 0, 'real signals are tracked for grading');

  const rec = await store.getSignal(keys[0]!);
  now = rec!.decisionAt + 15 * 60_000;
  spot = 548 * 1.01; // +1% — a win for a bullish call buy

  const written = await grader.tick();
  assert.ok(written > 0, 'at least one checkpoint was graded');

  const outcomes = await store.listOutcomes(keys[0]!);
  const m15 = outcomes.find((o) => o.horizon === 'M15');
  assert.ok(m15, 'M15 was graded');
  // The side is inferred from the NBBO the print carried: a fill at the ask is
  // a BUY, and a call buy is bullish, so a rise is POSITIVE.
  assert.equal(m15!.label, 'POSITIVE');
  assert.ok(m15!.excursion! > 0);
});

test('a replayed print yields EVENT_TIME_ONLY and is kept out of published rates', async (t) => {
  __clearSignalObservers();
  t.after(() => __clearSignalObservers());

  const store = new InMemorySignalStore();
  const recorder = new SignalRecorder(store, 'PRIVATE_RESEARCH');
  const signals = capture('DIA');

  const histTs = Date.parse('2026-01-15T15:00:00.000Z');
  feedCluster({ symbol: 'DIA', source: 'tradier', replay: true }, histTs);

  assert.ok(signals.length > 0);
  for (const { sig, origin } of signals) await recorder.record(sig, origin);

  const open = await store.listUngraded(50);
  assert.ok(open.length > 0);
  for (const rec of open) {
    assert.equal(rec.decisionBasis, 'EVENT_TIME_ONLY');
    // The decision time stays in January, where the data is — it is not
    // dragged to wall-clock "now".
    assert.ok(rec.decisionAt < Date.now() - 86_400_000);
  }

  const report = await store.trackRecord();
  assert.equal(report.rows.length, 0);
  assert.ok(report.excluded.eventTimeOnlyBasis > 0);
});

test('a signal whose print origins were evicted is refused, not recorded as real', async (t) => {
  // `printSource` is bounded at 20k entries and drops its oldest quarter under
  // load. Most bursts close within milliseconds, so they are never at risk —
  // but SPLIT holds its prints for a five-minute window, and on a busy tape
  // 20k prints can easily arrive inside five minutes. When a SPLIT finally
  // fires, its earliest prints' origins may be gone.
  //
  // The dangerous case is quiet: were an evicted print the simulated one and a
  // real print left standing, the signal would look real and attributable when
  // it is neither. Incomplete provenance must fail closed.
  __clearSignalObservers();
  t.after(() => __clearSignalObservers());

  const store = new InMemorySignalStore();
  const recorder = new SignalRecorder(store, 'PRIVATE_RESEARCH');
  const splits: Array<{ sig: ClassifiedSignal; origin: SignalOrigin }> = [];
  onSignal((sig, origin) => {
    if (sig.underlying === 'SPLITX' && sig.kind === 'SPLIT') splits.push({ sig, origin });
  });

  const base = Date.now();
  // Small prints: $10k each — under minSignalPremium (25k), blockMinSize (100)
  // and blockMinPremium (100k), and single-venue, so each falls through to the
  // SPLIT detector rather than being classified on its own.
  const small = (i: number) => print({
    symbol: 'SPLITX', id: `s-${i}`, ts: base + i * 500,
    strike: 500, price: 5, size: 20,
    exchanges: ['CBOE'], bid: 4.9, ask: 5.1, source: 'tradier',
  });

  ingestPrint(small(0));

  // Flood the origin map past its 20k cap while the SPLIT window is still open.
  for (let i = 0; i < 26_000; i++) {
    ingestPrint(print({
      symbol: 'FLOOD', id: `f-${i}`, ts: base + 1 + (i % 400),
      strike: 400 + (i % 60), price: 25.1, source: 'tradier',
    }));
  }

  // Now close the SPLIT: 5 more prints clears splitMinPrints and, at $10k each,
  // the $50k splitMinPremium.
  for (let i = 1; i <= 5; i++) ingestPrint(small(i));
  drainIdle(0);

  assert.ok(splits.length > 0, 'a SPLIT fired — otherwise this test proves nothing');

  const orphaned = splits.filter((s) => s.origin.sources.includes('unknown'));
  assert.ok(
    orphaned.length > 0,
    'the early prints\' origins were evicted — otherwise this test proves nothing',
  );

  for (const { sig, origin } of orphaned) {
    // Pessimistic on both axes when provenance is incomplete.
    assert.equal(origin.synthetic, true, 'cannot rule out a simulated print');
    const res = await recorder.record(sig, origin);
    assert.equal(res.status, 'REFUSED_RIGHTS', 'unattributable provenance is refused');
  }

  assert.equal((await store.countSignals()).total, 0, 'nothing unattributable was stored');
});
