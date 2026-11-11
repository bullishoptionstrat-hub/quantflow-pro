/**
 * Displacement: the definition in `src/structure/displacement.ts`, worked by hand.
 *
 * The yardstick is the true range of the n bars BEFORE the candidate. The
 * fixture is built so that including the candidate in its own ATR flips the
 * verdict — the candidate is large, so averaging it in makes it look smaller
 * than it is relative to what came before.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DisplacementEvent, atrBefore, detectDisplacement, trueRange } from '../src/structure/displacement';
import { resolveParams } from '../src/structure/params';
import { assertPrefixStable, closedBy, et, series } from './structureFixtures';

const T0 = et('2026-11-23', 10, 0);
const P = resolveParams({ atrPeriod: 3, displacementK: 1.5 });

//  i   o      h      l      c       TR
//  0   10     11     9      10      2          (first bar: high - low)
//  1   10     10.5   9.5    10      1
//  2   10     11     10     10.5    1          max(1, |11-10|, |10-10|)
//  3   10.5   12.7   10.4   12.6    2.3        body 2.1  vs 1.5 x (2+1+1)/3 = 2.0   -> BULL
//  4   12.6   12.65  10.2   10.3    2.45       body 2.3  vs 1.5 x (1+1+2.3)/3 = 2.15 -> BEAR
const BARS = series('SPY', '1m', T0, [
  [10, 11, 9, 10],
  [10, 10.5, 9.5, 10],
  [10, 11, 10, 10.5],
  [10.5, 12.7, 10.4, 12.6],
  [12.6, 12.65, 10.2, 10.3],
]);

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

test('true range reads the prior close; the first bar has none and uses its own range', () => {
  const tr = BARS.map((_, j) => trueRange(BARS, j));
  for (const [got, want] of tr.map((x, j) => [x, [2, 1, 1, 2.3, 2.45][j]])) assert.ok(close(got, want), `${got} vs ${want}`);
});

test('ATR is over the n bars before the candidate, never including it', () => {
  assert.equal(atrBefore(BARS, 2, 3), null, 'two prior bars are not three');
  assert.ok(close(atrBefore(BARS, 3, 3) as number, 4 / 3));
  assert.ok(close(atrBefore(BARS, 4, 3) as number, 4.3 / 3));
});

test('a bull and a bear displacement, each against the range before it', () => {
  const events = detectDisplacement(BARS, P).filter((e): e is DisplacementEvent => e.kind === 'DISPLACEMENT');
  assert.deepEqual(events.map((e) => [e.direction, e.knownAt]), [
    ['BULL', BARS[3].closedAt],
    ['BEAR', BARS[4].closedAt],
  ]);
  // Had bar 3 been inside its own yardstick, ATR would be (1 + 1 + 2.3) / 3
  // and the threshold 2.15 — above its 2.1 body. Bar 4 likewise: 2.875 > 2.3.
  assert.ok(close(events[0].atr, 4 / 3) && close(events[0].body, 2.1));
  assert.ok(close(events[0].ratio, 2.1 / (4 / 3)));
});

test('UNMEASURABLE until n prior bars exist — said, not skipped', () => {
  const early = detectDisplacement(BARS, P).filter((e) => e.kind === 'DISPLACEMENT_UNMEASURABLE');
  assert.deepEqual(early.map((e) => e.knownAt), [0, 1, 2].map((i) => BARS[i].closedAt));
  assert.match(early[2].kind === 'DISPLACEMENT_UNMEASURABLE' ? early[2].reason : '', /needs 3 prior bars for ATR\(3\); has 2/);
});

test('zero prior range is UNMEASURABLE, not a displacement of every bar', () => {
  const flat = series('SPY', '1m', T0, [[10, 10, 10, 10], [10, 10, 10, 10], [10, 10, 10, 10], [10, 10.2, 10, 10.1]]);
  const last = detectDisplacement(flat, P)[3];
  assert.equal(last.kind, 'DISPLACEMENT_UNMEASURABLE');
  if (last.kind === 'DISPLACEMENT_UNMEASURABLE') assert.match(last.reason, /zero true range/);
});

test('a doji is never a displacement, and a sub-threshold body emits nothing', () => {
  const quiet = series('SPY', '1m', T0, [...BARS.slice(0, 3).map((b) => [b.o, b.h, b.l, b.c] as [number, number, number, number]),
    [10.5, 12, 9, 10.5], [10.5, 10.9, 10.2, 10.8]]);
  const verdicts = detectDisplacement(quiet, P).slice(3);
  assert.deepEqual(verdicts, [], 'a wide doji and a small body: no event either way');
});

test('look-ahead guard', () => {
  assertPrefixStable('displacement', BARS.map((b) => b.closedAt), (asOf) => detectDisplacement(closedBy(BARS, asOf), P));
});
