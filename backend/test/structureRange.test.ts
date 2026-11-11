/**
 * The dealing range: the definition in `src/structure/range.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RangeEvent, detectRanges, zoneOf } from '../src/structure/range';
import { assertPrefixStable, et, fromHL, swingAt } from './structureFixtures';

const BARS = fromHL('SPY', '1m', et('2026-11-23', 10, 0), Array.from({ length: 13 }, () => [101, 99] as [number, number]));
const SWINGS = [
  swingAt(BARS, 'SWING_HIGH', 1, 3, 110),
  swingAt(BARS, 'SWING_LOW', 4, 6, 100),
  swingAt(BARS, 'SWING_HIGH', 7, 9, 108),
  swingAt(BARS, 'SWING_LOW', 10, 12, 109),
];

test('a range exists once both ends are confirmed, known at the later of the two', () => {
  const ev = detectRanges(SWINGS);
  assert.deepEqual(ev.map((e) => [e.kind, e.knownAt]), [
    ['DEALING_RANGE', BARS[6].closedAt],
    ['DEALING_RANGE', BARS[9].closedAt],
    ['RANGE_UNMEASURABLE', BARS[12].closedAt],
  ]);
  const first = ev[0] as RangeEvent;
  assert.equal(first.high.price, 110);
  assert.equal(first.low.price, 100);
  assert.equal(first.eq, 105);
  assert.deepEqual(first.premium, { from: 105, to: 110 });
  assert.deepEqual(first.discount, { from: 100, to: 105 });
  assert.equal((ev[1] as RangeEvent).eq, 104, 'a newer swing high replaces the old one');
});

test('a swing low above the swing high is not a range', () => {
  const last = detectRanges(SWINGS)[2];
  assert.equal(last.kind, 'RANGE_UNMEASURABLE');
  if (last.kind === 'RANGE_UNMEASURABLE') assert.match(last.reason, /108 is not above the most recent swing low 109/);
});

test('swings confirmed at the same close make one range, not two', () => {
  const both = [swingAt(BARS, 'SWING_HIGH', 2, 4, 110), swingAt(BARS, 'SWING_LOW', 3, 4, 100)];
  assert.equal(detectRanges(both).length, 1);
});

test('zoneOf: halves, the midpoint, and outside', () => {
  const r = detectRanges(SWINGS)[0] as RangeEvent;
  assert.deepEqual([111, 109, 105, 101, 99].map((p) => zoneOf(p, r)),
    ['ABOVE_RANGE', 'PREMIUM', 'EQUILIBRIUM', 'DISCOUNT', 'BELOW_RANGE']);
});

test('look-ahead guard', () => {
  assertPrefixStable('range', BARS.map((b) => b.closedAt), (asOf) => detectRanges(SWINGS.filter((s) => s.knownAt <= asOf)));
});
