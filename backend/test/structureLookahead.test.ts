/**
 * THE LOOK-AHEAD GUARD, on seeded random walks, for every detector and for
 * `analyse`.
 *
 * For each series the bars are fed one close at a time. At every step the
 * engine is re-run on the bars closed by then, and its output must equal the
 * batch run restricted to events known by then — the same events, the same
 * `knownAt`, every field. A detector that dates an event earlier than the bar
 * that justifies it, or that reads a bar it has not been given, produces an
 * event in the batch that the prefix cannot reproduce, and fails here.
 *
 * Separately, no event may cite a bar that closes after its own `knownAt`.
 *
 * A property over random data passes vacuously if the data never reaches the
 * branch that would break it. So the walks are seeded (reproducible), include
 * missing bars, a holiday, a half day and a date past the calendar's coverage,
 * and the last test asserts which event kinds were actually exercised — naming
 * the two that only the hand fixtures reach.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bar } from '../src/market/bar';
import { StructureEvent, analyse } from '../src/structure/index';
import { detectSwings } from '../src/structure/swings';
import { detectSessionLevels } from '../src/structure/levels';
import { detectFvgs } from '../src/structure/fvg';
import { detectDisplacement } from '../src/structure/displacement';
import { detectSweeps, levelsFromSessionLevels, levelsFromSwings } from '../src/structure/sweep';
import { detectStructureShifts } from '../src/structure/structureShift';
import { detectRanges } from '../src/structure/range';
import { detectSmt } from '../src/structure/smt';
import { assertPrefixStable, closedBy, randomWalks } from './structureFixtures';

const SEEDS = [1, 7, 42, 2026, 31337];
const THANKSGIVING_WEEK = ['2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-30'];
const COVERAGE_EDGE = ['2027-12-30', '2027-12-31', '2028-01-03'];

const walks = (seed: number, dates: string[], tf: Bar['tf'] = '5m') =>
  randomWalks({ symbols: ['SPY', 'QQQ'], tf, dates, seed, starts: [580, 500], dropProb: 0.03 }) as [Bar[], Bar[]];

const exercised = new Set<string>();

function analyseAt(a: Bar[], b: Bar[], asOf: number): StructureEvent[] {
  const r = analyse(closedBy(a, asOf), { pair: closedBy(b, asOf) });
  assert.equal(r.status, 'OK', r.status === 'REFUSED' ? r.reasons.join('; ') : '');
  return r.status === 'OK' ? r.events : [];
}

/** Every detector on its own, and then `analyse`, on one pair of series. */
function guardAll(label: string, a: Bar[], b: Bar[]): void {
  const closesA = a.map((x) => x.closedAt);
  const prefix = (asOf: number) => closedBy(a, asOf);

  assertPrefixStable(`${label}/swings`, closesA, (t) => detectSwings(prefix(t)));
  assertPrefixStable(`${label}/levels`, closesA, (t) => detectSessionLevels(prefix(t)));
  assertPrefixStable(`${label}/fvg`, closesA, (t) => detectFvgs(prefix(t)));
  assertPrefixStable(`${label}/displacement`, closesA, (t) => detectDisplacement(prefix(t)));
  assertPrefixStable(`${label}/sweeps`, closesA, (t) => {
    const bars = prefix(t);
    return detectSweeps(bars, [...levelsFromSessionLevels(detectSessionLevels(bars)), ...levelsFromSwings(detectSwings(bars))]);
  });
  assertPrefixStable(`${label}/shifts`, closesA, (t) => detectStructureShifts(prefix(t), detectSwings(prefix(t))));
  assertPrefixStable(`${label}/ranges`, closesA, (t) => detectRanges(detectSwings(prefix(t))));

  // Pairs are fed on the merged clock, from the first close at which both
  // symbols have a bar (a pair with one side empty is refused, not analysed).
  const start = Math.max(a[0].closedAt, b[0].closedAt);
  const merged = [...a, ...b].map((x) => x.closedAt).filter((t) => t >= start);
  assertPrefixStable(`${label}/smt`, merged, (t) => {
    const pa = closedBy(a, t), pb = closedBy(b, t);
    return detectSmt(pa, pb, detectSwings(pa), detectSwings(pb));
  });
  const batch = assertPrefixStable(`${label}/analyse`, merged, (t) => analyseAt(a, b, t));
  for (const e of batch) exercised.add(e.kind);
}

for (const seed of SEEDS) {
  test(`seed ${seed}: Thanksgiving week of 5m bars, a holiday, a half day and missing bars`, () => {
    const [a, b] = walks(seed, THANKSGIVING_WEEK);
    guardAll(`seed${seed}`, a, b);
  });
}

test('across the calendar\'s coverage edge: 2027-12-31 measures, 2028-01-03 is UNMEASURABLE', () => {
  const [a, b] = walks(99, COVERAGE_EDGE);
  guardAll('coverage-edge', a, b);
  const r = analyse(a, { pair: b });
  assert.ok(r.status === 'OK');
  const dates = new Set(r.events.filter((e) => e.kind === 'SESSION_LEVEL').map((e) => e.kind === 'SESSION_LEVEL' && e.sessionDate));
  assert.ok(dates.has('2027-12-31'));
  assert.ok(r.events.some((e) => e.kind === 'LEVEL_UNMEASURABLE' && e.sessionDate === '2028-01-03'));
});

test('one half day of 1m bars', () => {
  const [a, b] = walks(5, ['2026-11-27'], '1m');
  guardAll('1m-half-day', a, b);
});

test('the walks reached every event kind but the two only hand fixtures reach', () => {
  // Without this, a detector that silently stopped emitting would leave every
  // property above passing — there would be nothing for the guard to compare.
  const all = [
    'SWING_HIGH', 'SWING_LOW', 'SESSION_LEVEL', 'LEVEL_UNMEASURABLE', 'DEALING_RANGE', 'RANGE_UNMEASURABLE',
    'DISPLACEMENT', 'DISPLACEMENT_UNMEASURABLE',
    'FVG_FORMED', 'FVG_MITIGATED', 'FVG_FILLED', 'FVG_INVERTED', 'FVG_EXPIRED',
    'SWEEP_RECLAIM', 'ACCEPTED_BEYOND', 'BOS', 'CHOCH', 'SMT_DIVERGENCE', 'SMT_UNMEASURABLE',
  ];
  const missing = all.filter((k) => !exercised.has(k));
  assert.deepEqual(missing, [], `the random walks never produced: ${missing.join(', ')}`);
  // WICK_NO_RECLAIM needs every close in the window exactly at the level, and
  // SHIFT_AMBIGUOUS a swing low confirmed above an unbroken swing high. Both
  // are held by hand fixtures (structureSweep / structureShift), prefix guard
  // included.
});
