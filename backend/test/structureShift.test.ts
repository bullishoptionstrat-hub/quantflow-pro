/**
 * BOS and CHoCH: the definition in `src/structure/structureShift.ts`.
 *
 * Swings are given explicitly here, with their pivot and confirming bars, so
 * each case isolates one rule: closes not wicks, confirmed swings only, the
 * NEUTRAL start, and the label that follows a change of trend.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bar } from '../src/market/bar';
import { SwingEvent } from '../src/structure/swings';
import { ShiftEvent, detectStructureShifts } from '../src/structure/structureShift';
import { STRUCTURE_METHOD_VERSION } from '../src/structure/params';
import { refOf } from '../src/structure/types';
import { assertPrefixStable, closedBy, et, series } from './structureFixtures';

const T0 = et('2026-11-23', 10, 0);

/** Bars closing at the given prices, each with a small symmetric range. */
const closes = (cs: number[]): Bar[] => {
  let prev = cs[0];
  return series('SPY', '1m', T0, cs.map((c) => {
    const o = prev; prev = c;
    return [o, Math.max(o, c) + 0.05, Math.min(o, c) - 0.05, c] as [number, number, number, number];
  }));
};

const swing = (bars: Bar[], kind: SwingEvent['kind'], pivot: number, confirm: number, price: number): SwingEvent => ({
  id: `${kind}:${bars[pivot].tOpen}`,
  kind, symbol: 'SPY', tf: '1m', price,
  knownAt: bars[confirm].closedAt,
  methodVersion: STRUCTURE_METHOD_VERSION,
  evidence: bars.slice(pivot, confirm + 1).map(refOf),
  pivot: refOf(bars[pivot]),
  confirmedBy: refOf(bars[confirm]),
});

const shifts = (bars: Bar[], swings: SwingEvent[]) =>
  detectStructureShifts(bars, swings).map((e) => [e.kind, e.kind === 'SHIFT_AMBIGUOUS' ? null : (e as ShiftEvent).direction, bars.findIndex((b) => b.closedAt === e.knownAt)]);

// 0..20, closes chosen around the swings below.
const BARS = closes([99, 99.5, 99.8, 99.6, 99.4, 99, 98.6, 98.9, 100.5, 100.6, 100.7, 100.4, 100, 100.1, 100.2, 99.2, 99, 99.1, 99.1, 98.5, 98.4]);
const SWINGS = [
  swing(BARS, 'SWING_HIGH', 2, 4, 100),     // H1, known at 4
  swing(BARS, 'SWING_LOW', 6, 7, 98),       // L1, known at 7
  swing(BARS, 'SWING_HIGH', 10, 12, 101),   // H2, known at 12
  swing(BARS, 'SWING_LOW', 12, 14, 99.5),   // L2, known at 14
  swing(BARS, 'SWING_LOW', 16, 18, 98.8),   // L3, known at 18
];

test('first break from NEUTRAL is a BOS; a break against the trend is a CHOCH; with it, a BOS', () => {
  assert.deepEqual(shifts(BARS, SWINGS), [
    ['BOS', 'UP', 8],     // 100.5 > H1 100, trend NEUTRAL -> BULL
    ['CHOCH', 'DOWN', 15], // 99.2 < L2 99.5 while BULL
    ['BOS', 'DOWN', 19],   // 98.5 < L3 98.8 while BEAR
  ]);
  const [first] = detectStructureShifts(BARS, SWINGS) as ShiftEvent[];
  assert.equal(first.priorTrend, 'NEUTRAL');
  assert.equal(first.trendAfter, 'BULL');
  assert.equal(first.broken.price, 100);
});

test('a wick beyond a swing is not a break; only a close is', () => {
  const bars = closes([99, 99.5, 99.8, 99.6, 99.4, 99.5, 99.7, 99.9, 99.6]);
  bars[7] = { ...bars[7], h: 100.8 }; // wicks far above H1 = 100, closes at 99.9
  assert.deepEqual(shifts(bars, [swing(bars, 'SWING_HIGH', 2, 4, 100)]), []);
});

test('a swing not yet confirmed cannot be broken, and does not displace the confirmed one', () => {
  // H1 = 98 is confirmed at bar 4. H2 = 99 pivots at bar 6 but is not
  // confirmed until bar 8. Bar 7 closes at 98.5 — above H1, below H2. At bar
  // 7's close the only swing high that exists is H1, so this is a BOS of H1.
  const bars = closes([97, 97.5, 97.8, 97.6, 97.4, 97.7, 97.9, 98.5, 98.3]);
  const s = [swing(bars, 'SWING_HIGH', 2, 4, 98), swing(bars, 'SWING_HIGH', 6, 8, 99)];
  assert.deepEqual(shifts(bars, s), [['BOS', 'UP', 7]]);
  const [e] = detectStructureShifts(bars, s) as ShiftEvent[];
  assert.equal(e.broken.price, 98, 'it is H1 that broke, not the unconfirmed H2');
  assert.ok(e.broken.knownAt <= e.knownAt);
});

test('a swing confirmed after a bar closes is invisible to that bar', () => {
  // The swing at 98 is confirmed at bar 6's close. Bar 5 closed above it a
  // bar earlier, when it did not yet exist; bar 6 closes back below.
  const bars = closes([97, 97.5, 97.8, 97.6, 97.4, 98.6, 97.9]);
  assert.deepEqual(shifts(bars, [swing(bars, 'SWING_HIGH', 2, 6, 98)]), [],
    'bar 5 closed above 98 before the swing was confirmed');
});

test('a broken reference is spent: no second break until a newer swing is confirmed', () => {
  const bars = closes([99, 99.5, 99.8, 99.6, 99.4, 100.2, 99.8, 100.4, 100.9]);
  const s = [swing(bars, 'SWING_HIGH', 2, 4, 100)];
  assert.deepEqual(shifts(bars, s), [['BOS', 'UP', 5]], 'bars 7 and 8 also close above 100 and break nothing');
});

test('one close beyond both references is SHIFT_AMBIGUOUS and leaves the trend alone', () => {
  // H = 100 confirmed at bar 4 (bar 4 closes 99.9, no break); L = 101
  // confirmed at bar 5, above H. Bar 5 closes at 100.5 — above one reference
  // and below the other.
  const bars = closes([99, 99.5, 99.8, 99.6, 99.9, 100.5, 102.5, 100.8]);
  const s = [swing(bars, 'SWING_HIGH', 2, 4, 100), swing(bars, 'SWING_LOW', 3, 5, 101)];
  const ev = detectStructureShifts(bars, s);
  assert.deepEqual(ev.map((e) => [e.kind, bars.findIndex((b) => b.closedAt === e.knownAt)]), [['SHIFT_AMBIGUOUS', 5]],
    'both references are spent, so bar 6 at 102.5 breaks nothing');
});

test('look-ahead guard', () => {
  assertPrefixStable('shift', BARS.map((b) => b.closedAt), (asOf) =>
    detectStructureShifts(closedBy(BARS, asOf), SWINGS.filter((s) => s.knownAt <= asOf)));
});
