/**
 * Sweeps of named levels: the definition in `src/structure/sweep.ts`.
 *
 * A sweep needs two things — a wick beyond a level that was ALREADY known, and
 * a close back inside within the window. Either alone is something else: a
 * close beyond first is acceptance, a wick with no close back is a wick.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bar } from '../src/market/bar';
import { SweepLevel, detectSweeps, levelsFromSessionLevels, levelsFromSwings } from '../src/structure/sweep';
import { detectSessionLevels } from '../src/structure/levels';
import { detectSwings } from '../src/structure/swings';
import { assertPrefixStable, bar, closedBy, et, fromHL, series } from './structureFixtures';

const T0 = et('2026-11-23', 10, 0);
const AT_LEVEL: [number, number, number, number] = [99.8, 100.4, 99.7, 100]; // wick above, close exactly at 100

const highLevel = (knownAt = T0): SweepLevel => ({
  id: 'LVL', name: 'TEST_HIGH', side: 'HIGH', price: 100, knownAt,
  evidence: [{ id: 'SPY:1m:0', symbol: 'SPY', tOpen: knownAt - 60_000, closedAt: knownAt }],
});
const lowLevel = (): SweepLevel => ({ ...highLevel(), id: 'LVL_LOW', name: 'TEST_LOW', side: 'LOW' });

const mirror = (bars: Bar[]): Bar[] => bars.map((b) => ({ ...b, o: 200 - b.o, c: 200 - b.c, h: 200 - b.l, l: 200 - b.h }));
const run = (rows: [number, number, number, number][], level = highLevel()) =>
  detectSweeps(series('SPY', '1m', T0, rows), [level]).map((e) => [e.kind, e.barsAfterExcursion, e.extreme]);

test('a wick above and a close back below on the same bar is a sweep-and-reclaim', () => {
  assert.deepEqual(run([[99.5, 100.5, 99.4, 99.8]]), [['SWEEP_RECLAIM', 0, 100.5]]);
});

test('the reclaim may come within the window, after a bar that settles nothing', () => {
  assert.deepEqual(run([AT_LEVEL, [100, 100.3, 99.6, 99.9]]), [['SWEEP_RECLAIM', 1, 100.4]]);
});

test('a close beyond before any reclaim is ACCEPTED_BEYOND, not a sweep', () => {
  assert.deepEqual(run([[99.8, 100.6, 99.7, 100.3]]), [['ACCEPTED_BEYOND', 0, 100.6]]);
  assert.deepEqual(run([AT_LEVEL, [100, 100.8, 99.9, 100.5], [100.5, 100.6, 99, 99.5]]), [['ACCEPTED_BEYOND', 1, 100.8]],
    'and a later close back inside does not turn acceptance into a sweep');
});

test('a wick with no close back inside within the window is not a sweep either', () => {
  const events = detectSweeps(series('SPY', '1m', T0, [AT_LEVEL, AT_LEVEL, AT_LEVEL, [100, 100.1, 99, 99.2]]), [highLevel()]);
  assert.deepEqual(events.map((e) => [e.kind, e.barsAfterExcursion]), [['WICK_NO_RECLAIM', 2]]);
  assert.equal(events[0].knownAt, T0 + 3 * 60_000, 'known at the close of the window\'s last bar');
  // The close back below on bar 3 is outside the 3-bar window and the level is
  // spent: it is not reported as a late sweep.
});

test('a level must be known when the bar opens: a wick during the bar it became known is not an excursion', () => {
  const lvl = highLevel(T0 + 30_000); // known half-way through bar 0
  const events = detectSweeps(series('SPY', '1m', T0, [[99.5, 100.5, 99.4, 99.8], [99.5, 100.7, 99.4, 99.8]]), [lvl]);
  assert.deepEqual(events.map((e) => [e.kind, e.excursion.tOpen, e.extreme]), [['SWEEP_RECLAIM', T0 + 60_000, 100.7]]);
});

test('unresolved and untouched levels emit nothing yet', () => {
  assert.deepEqual(run([AT_LEVEL]), [], 'one bar of a three-bar window settles nothing');
  assert.deepEqual(run([[99, 99.9, 98.9, 99.5]]), [], 'never reached');
});

test('LOW-side levels mirror it', () => {
  const rows: [number, number, number, number][] = [[99.5, 100.5, 99.4, 99.8]];
  const ev = detectSweeps(mirror(series('SPY', '1m', T0, rows)), [lowLevel()]);
  assert.deepEqual(ev.map((e) => [e.kind, e.side, e.extreme]), [['SWEEP_RECLAIM', 'LOW', 99.5]]);
  const acc = detectSweeps(mirror(series('SPY', '1m', T0, [[99.8, 100.6, 99.7, 100.3]])), [lowLevel()]);
  assert.deepEqual(acc.map((e) => e.kind), ['ACCEPTED_BEYOND']);
});

test('evidence carries the level\'s own bars, so knownAt is checkable from the event alone', () => {
  const [e] = detectSweeps(series('SPY', '1m', T0, [AT_LEVEL, [100, 100.3, 99.6, 99.9]]), [highLevel()]);
  assert.ok(e.evidence.some((r) => r.id === 'SPY:1m:0'));
  for (const r of e.evidence) assert.ok(r.closedAt <= e.knownAt);
});

test('swings and COMPLETE prior-session levels become sweep levels; INCOMPLETE ones do not', () => {
  const swings = detectSwings(fromHL('SPY', '1m', T0, [[10, 9], [11, 10], [13, 12], [12, 11], [11, 10]]));
  assert.deepEqual(levelsFromSwings(swings).map((l) => [l.side, l.price, l.knownAt]), [['HIGH', 13, swings[0].knownAt]]);

  const full = Array.from({ length: 26 }, (_, k) => bar('SPY', '15m', et('2026-11-24', 9, 30) + k * 900_000, 100, 101, 99, 100));
  const next = bar('SPY', '15m', et('2026-11-25', 9, 30), 100, 101, 99, 100);
  assert.deepEqual(levelsFromSessionLevels(detectSessionLevels([...full, next])).map((l) => [l.name, l.side]), [['PDH', 'HIGH'], ['PDL', 'LOW']]);
  assert.deepEqual(levelsFromSessionLevels(detectSessionLevels([...full.slice(0, 25), next])), [],
    'a session missing a bar may not have printed its real high; a sweep of it would be a sweep of nothing');
});

test('look-ahead guard', () => {
  const fixtures: [number, number, number, number][][] = [
    [AT_LEVEL, [100, 100.3, 99.6, 99.9]],
    [AT_LEVEL, AT_LEVEL, AT_LEVEL, [100, 100.1, 99, 99.2]],
    [AT_LEVEL, [100, 100.8, 99.9, 100.5]],
  ];
  for (const rows of fixtures) {
    const bars = series('SPY', '1m', T0, rows);
    assertPrefixStable('sweep', bars.map((b) => b.closedAt), (asOf) => detectSweeps(closedBy(bars, asOf), [highLevel()]));
  }
});
