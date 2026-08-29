import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySignalStore } from '../src/persistence/memoryStore';
import { HORIZON_OFFSETS_MS, SignalGrader } from '../src/persistence/grader';
import type { SignalRecord } from '../src/persistence/types';

const T0 = Date.parse('2026-08-29T14:30:00.000Z');
const M15 = HORIZON_OFFSETS_MS.M15;

function rec(over: Partial<SignalRecord> = {}): SignalRecord {
  const key = over.signalKey ?? 'k1';
  return {
    signalKey: key, contentHash: key, engineId: 'sig_1_x',
    kind: 'SWEEP', underlying: 'SPY', side: 'BUY',
    totalPremium: 250_000, totalSize: 100, iso: true, score: 82,
    scoreBreakdown: {},
    legs: [{
      contractSymbol: 'SPY260919C00550000', underlying: 'SPY',
      right: 'C', strike: 550, expiry: '2026-09-19', side: 'BUY',
      totalSize: 100, totalPremium: 250_000, vwap: 25, prints: 3,
      exchanges: ['CBOE'],
    }],
    firstEventAt: T0, lastEventAt: T0 + 500, decisionAt: T0 + 530,
    decisionBasis: 'OBSERVED', latencyMs: 30,
    source: 'tradier', datasetId: 'TRADIER_STREAM', rightsClass: 'PERMITTED',
    synthetic: false, recordedAt: T0 + 600,
    ...over,
  };
}

/** A clock and a spot feed the test drives directly. */
function harness(prices: number[]) {
  const store = new InMemorySignalStore();
  let now = T0 + 600;
  let idx = 0;
  const g = new SignalGrader(
    store,
    () => prices[Math.min(idx, prices.length - 1)],
    {},
    () => now,
  );
  return {
    store, grader: g,
    advanceTo(ms: number) { now = ms; },
    setPriceIndex(i: number) { idx = i; },
  };
}

test('nothing is graded before the checkpoint falls due', async () => {
  const h = harness([500]);
  h.grader.register(rec());
  h.advanceTo(T0 + 530 + M15 - 1);
  assert.equal(await h.grader.tick(), 0);
});

test('a move in the implied direction beyond the dead band is POSITIVE', async () => {
  const h = harness([500, 505]); // +1% on a bullish signal
  h.grader.register(rec());
  h.setPriceIndex(1);
  h.advanceTo(T0 + 530 + M15);

  assert.equal(await h.grader.tick(), 1);
  const [o] = await h.store.listOutcomes('k1');
  assert.equal(o!.label, 'POSITIVE');
  assert.ok(Math.abs(o!.excursion! - 0.01) < 1e-9);
  assert.equal(o!.entryMark, 500);
  assert.equal(o!.exitMark, 505);
});

test('direction is applied with the right sign: a bearish signal scores on a fall', async () => {
  // Buying puts is bearish, so a falling underlying is a positive excursion.
  const h = harness([500, 495]);
  h.grader.register(rec({
    legs: [{ ...rec().legs[0]!, right: 'P', side: 'BUY' }],
  }));
  h.setPriceIndex(1);
  h.advanceTo(T0 + 530 + M15);

  await h.grader.tick();
  const [o] = await h.store.listOutcomes('k1');
  assert.equal(o!.label, 'POSITIVE');
  assert.ok(o!.excursion! > 0, 'a fall is a win for a bearish signal');
});

test('a move against the signal is NEGATIVE', async () => {
  const h = harness([500, 490]);
  h.grader.register(rec());
  h.setPriceIndex(1);
  h.advanceTo(T0 + 530 + M15);

  await h.grader.tick();
  assert.equal((await h.store.listOutcomes('k1'))[0]!.label, 'NEGATIVE');
});

test('a move inside the dead band is FLAT, not a coin-flip win', async () => {
  // Without a dead band, fourth-decimal noise is scored as a hit about half
  // the time and the rate converges on 50% for reasons unrelated to the signal.
  const h = harness([500, 500.02]); // +0.004%, inside the 0.1% band
  h.grader.register(rec());
  h.setPriceIndex(1);
  h.advanceTo(T0 + 530 + M15);

  await h.grader.tick();
  assert.equal((await h.store.listOutcomes('k1'))[0]!.label, 'FLAT');
});

test('an AMBIGUOUS side is UNGRADED with a reason, never assigned a direction', async () => {
  const h = harness([500, 520]);
  h.grader.register(rec({ legs: [{ ...rec().legs[0]!, side: 'AMBIGUOUS' }] }));
  h.setPriceIndex(1);
  h.advanceTo(T0 + 530 + M15);

  await h.grader.tick();
  const [o] = await h.store.listOutcomes('k1');
  assert.equal(o!.label, 'UNGRADED');
  assert.match(o!.ungradedReason!, /implies no direction/);
  assert.equal(o!.excursion, undefined);
});

test('a missing entry mark is UNGRADED rather than interpolated', async () => {
  const store = new InMemorySignalStore();
  let now = T0 + 600;
  const g = new SignalGrader(store, () => undefined, {}, () => now);
  g.register(rec());
  now = T0 + 530 + M15;

  await g.tick();
  const [o] = await store.listOutcomes('k1');
  assert.equal(o!.label, 'UNGRADED');
  assert.match(o!.ungradedReason!, /No usable entry mark/);
});

test('a checkpoint observed far too late is UNGRADED rather than graded against a stale move', async () => {
  // The free tier sleeps. Waking six hours late and grading M15 against a
  // six-hour move would be a fabricated measurement.
  const h = harness([500, 550]);
  h.grader.register(rec());
  h.setPriceIndex(1);
  h.advanceTo(T0 + 530 + M15 + 6 * 60 * 60_000);

  await h.grader.tick();
  const [o] = await h.store.listOutcomes('k1');
  assert.equal(o!.label, 'UNGRADED');
  assert.match(o!.ungradedReason!, /came due .* minutes ago/);
});

test('synthetic signals are not tracked at all', async () => {
  const h = harness([500, 550]);
  h.grader.register(rec({ synthetic: true }));
  h.setPriceIndex(1);
  h.advanceTo(T0 + 530 + M15);

  assert.equal(await h.grader.tick(), 0);
  assert.equal(h.grader.getStats().tracked, 0);
});

test('each horizon is graded once, and the signal is dropped when all are done', async () => {
  const h = harness([500, 505]);
  h.grader.register(rec());
  h.setPriceIndex(1);

  h.advanceTo(T0 + 530 + HORIZON_OFFSETS_MS.M15);
  assert.equal(await h.grader.tick(), 1);
  assert.equal(await h.grader.tick(), 0, 'M15 is not graded twice');

  h.advanceTo(T0 + 530 + HORIZON_OFFSETS_MS.H1);
  assert.equal(await h.grader.tick(), 1);
  h.advanceTo(T0 + 530 + HORIZON_OFFSETS_MS.D1);
  assert.equal(await h.grader.tick(), 1);

  assert.equal(h.grader.getStats().tracked, 0);
  const horizons = (await h.store.listOutcomes('k1')).map((o) => o.horizon).sort();
  assert.deepEqual(horizons, ['D1', 'H1', 'M15']);
});

test('grading is scheduled from decisionAt, not from the first print', async () => {
  // A signal whose burst began well before its decision instant must not have
  // its checkpoint pulled forward by the burst duration.
  const h = harness([500, 505]);
  h.grader.register(rec({ firstEventAt: T0 - 600_000, decisionAt: T0 + 530 }));
  h.setPriceIndex(1);

  h.advanceTo(T0 - 600_000 + M15 + 1);
  assert.equal(await h.grader.tick(), 0, 'not due yet — the first print does not start the clock');

  h.advanceTo(T0 + 530 + M15);
  assert.equal(await h.grader.tick(), 1);
});

test('stats tally graded, ungraded and label counts', async () => {
  const h = harness([500, 505]);
  h.grader.register(rec({ signalKey: 'a' }));
  h.grader.register(rec({ signalKey: 'b', legs: [{ ...rec().legs[0]!, side: 'AMBIGUOUS' }] }));
  h.setPriceIndex(1);
  h.advanceTo(T0 + 530 + M15);

  await h.grader.tick();
  const s = h.grader.getStats();
  assert.equal(s.graded, 1);
  assert.equal(s.positive, 1);
  assert.equal(s.ungraded, 1);
});
