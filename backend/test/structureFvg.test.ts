/**
 * Fair-value gaps and their lifecycle: the definition in `src/structure/fvg.ts`.
 *
 * The lifecycle events are separate on purpose. "Price came back to the gap"
 * (MITIGATED), "price traded through it" (FILLED) and "price CLOSED through it"
 * (INVERTED) are three different facts, and a tool that reports the third as
 * the first is reporting a failed level as a working one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bar } from '../src/market/bar';
import { FvgEvent, detectFvgs } from '../src/structure/fvg';
import { resolveParams } from '../src/structure/params';
import { MIN, assertPrefixStable, closedBy, et, series } from './structureFixtures';

const T0 = et('2026-11-23', 10, 0);

const BULL_ROWS: [number, number, number, number][] = [
  [99.5, 100, 99, 99.8],      // 0 a
  [99.8, 103, 99.5, 102.8],   // 1 b
  [102.8, 104, 101, 103.5],   // 2 c   low 101 > high(a) 100: gap [100, 101]
  [103.5, 104.5, 101.5, 104], // 3     stays above the gap
  [104, 104.2, 100.8, 101.2], // 4     low 100.8 <= top 101: MITIGATED
  [101.2, 101.5, 99.9, 100.5],// 5     low 99.9 <= bottom 100: FILLED; close 100.5 is not beyond
  [100.5, 100.9, 99.5, 99.7], // 6     close 99.7 < bottom 100: INVERTED
  [99.7, 99.9, 99, 99.2],     // 7     nothing: the gap is finished
];
const BULL = series('SPY', '1m', T0, BULL_ROWS);

/** Reflect a series through 100 so a bullish fixture becomes its bearish twin. */
const mirror = (bars: Bar[]): Bar[] =>
  bars.map((b) => ({ ...b, o: 200 - b.o, c: 200 - b.c, h: 200 - b.l, l: 200 - b.h }));

const life = (events: FvgEvent[]) => events.map((e) => [e.kind, e.barsSinceFormation]);

test('bullish: formed, then mitigated, filled and inverted on the bars that do each', () => {
  const events = detectFvgs(BULL);
  assert.deepEqual(life(events), [
    ['FVG_FORMED', 0], ['FVG_MITIGATED', 2], ['FVG_FILLED', 3], ['FVG_INVERTED', 4],
  ]);
  const formed = events[0];
  assert.equal(formed.direction, 'BULLISH');
  assert.equal(formed.bottom, 100);
  assert.equal(formed.top, 101);
  assert.equal(formed.knownAt, BULL[2].closedAt, 'known at the close of the third bar');
  assert.deepEqual(events.map((e) => e.knownAt), [2, 4, 5, 6].map((i) => BULL[i].closedAt));
});

test('a wick through the far edge is a FILL, not an inversion; only a close inverts', () => {
  const events = detectFvgs(BULL);
  const filled = events.find((e) => e.kind === 'FVG_FILLED');
  const inverted = events.find((e) => e.kind === 'FVG_INVERTED');
  assert.equal(filled?.knownAt, BULL[5].closedAt, 'bar 5 trades to 99.9, below the bottom, and closes back at 100.5');
  assert.equal(inverted?.knownAt, BULL[6].closedAt, 'bar 6 is the first CLOSE below the bottom');
});

test('an inversion is never reported as a mitigation', () => {
  const events = detectFvgs(BULL);
  assert.equal(events.filter((e) => e.kind === 'FVG_MITIGATED').length, 1, 'one mitigation, the first touch');
  assert.equal(events.filter((e) => e.kind === 'FVG_INVERTED').length, 1);
  assert.notEqual(
    events.find((e) => e.kind === 'FVG_MITIGATED')?.knownAt,
    events.find((e) => e.kind === 'FVG_INVERTED')?.knownAt,
    'and the inverting bar is not the mitigating one here',
  );
});

test('bearish mirrors it exactly', () => {
  const events = detectFvgs(mirror(BULL));
  assert.deepEqual(life(events), [
    ['FVG_FORMED', 0], ['FVG_MITIGATED', 2], ['FVG_FILLED', 3], ['FVG_INVERTED', 4],
  ]);
  assert.equal(events[0].direction, 'BEARISH');
  assert.equal(events[0].bottom, 99);
  assert.equal(events[0].top, 100);
});

test('one bar can mitigate, fill and invert: three events, in that order, at one close', () => {
  const bars = series('SPY', '1m', T0, [...BULL_ROWS.slice(0, 3), [103.5, 103.6, 99, 99.5]]);
  const events = detectFvgs(bars);
  assert.deepEqual(life(events), [['FVG_FORMED', 0], ['FVG_MITIGATED', 1], ['FVG_FILLED', 1], ['FVG_INVERTED', 1]]);
});

test('expiry: tracked for fvgExpiryBars bars, then EXPIRED and silent', () => {
  const p = resolveParams({ fvgExpiryBars: 3 });
  const hold: [number, number, number, number] = [103.5, 104.5, 101.5, 104];
  const kill: [number, number, number, number] = [104, 104, 98, 98.5];
  const expired = detectFvgs(series('SPY', '1m', T0, [...BULL_ROWS.slice(0, 3), hold, hold, hold, kill]), p);
  assert.deepEqual(life(expired), [['FVG_FORMED', 0], ['FVG_EXPIRED', 3]],
    'the close below the gap on bar 6 comes after expiry and is not reported');

  const invertsOnLast = detectFvgs(series('SPY', '1m', T0, [...BULL_ROWS.slice(0, 3), hold, hold, kill]), p);
  assert.deepEqual(life(invertsOnLast), [['FVG_FORMED', 0], ['FVG_MITIGATED', 3], ['FVG_FILLED', 3], ['FVG_INVERTED', 3]],
    'an inversion on the last tracked bar is an inversion, not an expiry');
});

test('a gap across missing bars is not a fair-value gap', () => {
  const bars = BULL.slice(0, 3).map((b, i) => (i === 2 ? { ...b, tOpen: b.tOpen + MIN, closedAt: b.closedAt + MIN } : b));
  assert.deepEqual(detectFvgs(bars), []);
});

test('look-ahead guard on every fixture above', () => {
  const p = resolveParams({ fvgExpiryBars: 3 });
  const hold: [number, number, number, number] = [103.5, 104.5, 101.5, 104];
  for (const [name, bars] of [
    ['bull', BULL], ['bear', mirror(BULL)],
    ['expiry', series('SPY', '1m', T0, [...BULL_ROWS.slice(0, 3), hold, hold, hold, hold])],
  ] as const) {
    assertPrefixStable(`fvg/${name}`, bars.map((b) => b.closedAt), (asOf) => detectFvgs(closedBy(bars, asOf), p));
  }
});
