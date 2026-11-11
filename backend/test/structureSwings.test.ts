/**
 * Confirmed swings: the definition in `src/structure/swings.ts`, worked by hand.
 *
 * The property that matters most is the one a chart cannot show: a pivot is
 * known at the close of the bar that CONFIRMS it, never at the pivot. A swing
 * high drawn at its own bar is a swing high nobody could have traded against
 * until two bars later, and a backtest that uses it at its own bar is reading
 * the future.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectSwings } from '../src/structure/swings';
import { resolveParams } from '../src/structure/params';
import { StructureInputError } from '../src/structure/types';
import { MIN, assertPrefixStable, closedBy, et, fromHL, series } from './structureFixtures';

const T0 = et('2026-11-23', 10, 0);

// highs 10 11 13 12 11 12 14 14 13 12 ; lows = high - 1
const HL: [number, number][] = [10, 11, 13, 12, 11, 12, 14, 14, 13, 12].map((h) => [h, h - 1]);
const BARS = fromHL('SPY', '1m', T0, HL);

test('a swing high is known at the close of its pivotRight-th bar, not at its own', () => {
  const highs = detectSwings(BARS).filter((s) => s.kind === 'SWING_HIGH');
  assert.deepEqual(highs.map((s) => [s.pivot.tOpen, s.price, s.knownAt]), [
    [BARS[2].tOpen, 13, BARS[4].closedAt],
    [BARS[6].tOpen, 14, BARS[8].closedAt],
  ]);
  for (const s of highs) {
    assert.ok(s.knownAt > s.pivot.closedAt, 'never emitted at its own bar');
    assert.equal(s.confirmedBy.closedAt, s.knownAt);
    assert.equal(s.evidence.length, 5, 'cites the 2 + 1 + 2 bars the definition reads');
  }
});

test('equal highs: the earliest of the run is the pivot, the later one is refused', () => {
  // Bars 6 and 7 both print 14. Strict-left / non-strict-right picks bar 6
  // and refuses bar 7, which has an equal high to its left.
  const highs = detectSwings(BARS).filter((s) => s.kind === 'SWING_HIGH');
  assert.ok(highs.some((s) => s.pivot.tOpen === BARS[6].tOpen));
  assert.ok(!highs.some((s) => s.pivot.tOpen === BARS[7].tOpen));
});

test('swing lows mirror it, ties included', () => {
  const lows = detectSwings(BARS).filter((s) => s.kind === 'SWING_LOW');
  assert.deepEqual(lows.map((s) => [s.pivot.tOpen, s.price, s.knownAt]), [[BARS[4].tOpen, 10, BARS[6].closedAt]]);

  const tie = fromHL('SPY', '1m', T0, [[13, 12], [12, 11], [11, 10], [11, 10], [12, 11], [13, 12]]);
  const tieLows = detectSwings(tie).filter((s) => s.kind === 'SWING_LOW');
  assert.deepEqual(tieLows.map((s) => s.pivot.tOpen), [tie[2].tOpen], 'the first of two equal lows');
});

test('nothing at the edges: too few bars left, or not yet enough bars right', () => {
  // Bar 9 is the last bar; it cannot be judged until two more bars exist.
  const all = detectSwings(BARS);
  for (const s of all) {
    const i = BARS.findIndex((b) => b.tOpen === s.pivot.tOpen);
    assert.ok(i >= 2 && i <= BARS.length - 3, `pivot ${i} is inside the judgeable range`);
  }
  assert.deepEqual(detectSwings(BARS.slice(0, 4)), [], 'pivot at 2 is not known with only 1 bar to its right');
  assert.equal(detectSwings(BARS.slice(0, 5)).filter((s) => s.kind === 'SWING_HIGH').length, 1, 'and is known with 2');
});

test('a time gap is not filled: the N bars that exist are the N bars counted', () => {
  // Remove nothing, but open bar 4 an hour late. The pivot at 2 is still
  // confirmed by the bar that is second after it, at that bar's own close.
  const gapped = BARS.map((b, i) => (i >= 4 ? { ...b, tOpen: b.tOpen + 60 * MIN, closedAt: b.closedAt + 60 * MIN } : b));
  const first = detectSwings(gapped).find((s) => s.kind === 'SWING_HIGH');
  assert.equal(first?.pivot.tOpen, gapped[2].tOpen);
  assert.equal(first?.knownAt, gapped[4].closedAt, 'known when the confirming bar actually closed');
});

test('an outside bar can be both a swing high and a swing low', () => {
  const b = series('SPY', '1m', T0, [
    [10, 10.5, 9.5, 10], [10, 10.4, 9.6, 10], [10, 11, 9, 10], [10, 10.4, 9.6, 10], [10, 10.5, 9.5, 10],
  ]);
  assert.deepEqual(detectSwings(b).map((s) => s.kind).sort(), ['SWING_HIGH', 'SWING_LOW']);
});

test('pivot widths are parameters; a right width of 0 is refused, not read as 1', () => {
  // The right width IS the confirmation delay: at 1 the same pivots are known
  // one bar after themselves, at 2 two bars after.
  const narrow = detectSwings(BARS, resolveParams({ pivotLeft: 1, pivotRight: 1 }));
  assert.ok(narrow.length > 0);
  for (const s of narrow) {
    const i = BARS.findIndex((b) => b.tOpen === s.pivot.tOpen);
    assert.equal(s.knownAt, BARS[i + 1].closedAt);
  }
  assert.notEqual(narrow[0].methodVersion, detectSwings(BARS)[0].methodVersion, 'and the version says which');
  assert.throws(() => resolveParams({ pivotRight: 0 }), /pivotRight must be an integer of at least 1/);
});

test('a malformed series is refused, not repaired', () => {
  const swapped = [BARS[1], BARS[0], ...BARS.slice(2)];
  assert.throws(() => detectSwings(swapped), StructureInputError);
});

test('look-ahead guard: every prefix reproduces the batch run truncated at its last close', () => {
  assertPrefixStable('swings', BARS.map((b) => b.closedAt), (asOf) => detectSwings(closedBy(BARS, asOf)));
});
