/**
 * ROADMAP 5.5 — the 25-delta risk reversal per expiry, from the chain.
 *
 * Skew is a selection among rows Cboe sent, not a computation: the put and
 * the call whose published |delta| is nearest 0.25. Nothing is interpolated,
 * and the delta actually chosen is published so "25Δ" never means 0.31
 * silently.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skewOf, deltaOrNull, SKEW_BASIS, TARGET_DELTA, type SkewInput } from '../src/ingestion/skew';

const r = (expiry: string, strike: number, right: 'C' | 'P', iv: number | null, delta: number | null): SkewInput =>
  ({ expiry, strike, right, iv, delta });

test('each leg is the contract whose |delta| is nearest 0.25, and the chosen delta is published', () => {
  const s = skewOf([
    r('2026-11-20', 90, 'P', 0.30, -0.10),
    r('2026-11-20', 95, 'P', 0.26, -0.22),   // nearest 0.25 among puts
    r('2026-11-20', 100, 'P', 0.22, -0.48),
    r('2026-11-20', 100, 'C', 0.20, 0.52),
    r('2026-11-20', 105, 'C', 0.18, 0.31),   // nearest 0.25 among calls
    r('2026-11-20', 110, 'C', 0.17, 0.12),
  ], '2026-10-21');
  const [pt] = s.points;
  assert.deepEqual(pt!.put, { strike: 95, delta: -0.22, iv: 0.26 });
  assert.deepEqual(pt!.call, { strike: 105, delta: 0.31, iv: 0.18 });
  assert.ok(Math.abs(pt!.riskReversal! - 0.08) < 1e-12, 'put IV minus call IV');
  assert.ok(Math.abs(pt!.riskReversalPct! - 8) < 1e-9);
  assert.equal(pt!.dte, 30);
  assert.equal(pt!.contracts, 6);
  assert.equal(pt!.ivMissing, 0);
  assert.equal(pt!.deltaMissing, 0);
});

test('a tie in distance from 0.25 goes to the lower strike, whatever the row order', () => {
  const rows = [
    r('2026-11-20', 105, 'C', 0.18, 0.30),  // |0.30-0.25| = 0.05
    r('2026-11-20', 103, 'C', 0.19, 0.20),  // |0.20-0.25| = 0.05
  ];
  const a = skewOf(rows, null).points[0]!.call!.strike;
  const b = skewOf([...rows].reverse(), null).points[0]!.call!.strike;
  assert.equal(a, 103);
  assert.equal(b, 103);
});

test('one side alone is a point, not a skew: the risk reversal is null', () => {
  const s = skewOf([
    r('2026-11-20', 95, 'P', 0.26, -0.24),
    r('2026-11-20', 105, 'C', 0.18, null),   // call with no delta
  ], null);
  const [pt] = s.points;
  assert.ok(pt!.put !== null);
  assert.equal(pt!.call, null);
  assert.equal(pt!.riskReversal, null);
  assert.equal(pt!.riskReversalPct, null);
  assert.equal(pt!.deltaMissing, 1);
});

test('a delta with the wrong sign, zero, or beyond one is missing, not selected', () => {
  assert.equal(deltaOrNull('C', -0.25), null, 'a call cannot have a negative delta');
  assert.equal(deltaOrNull('P', 0.25), null, 'a put cannot have a positive delta');
  assert.equal(deltaOrNull('C', 0), null, 'zero is an unquoted row');
  assert.equal(deltaOrNull('P', 0), null);
  assert.equal(deltaOrNull('C', 1.2), null, '|delta| > 1 is not a delta');
  assert.equal(deltaOrNull('P', -1.0001), null);
  assert.equal(deltaOrNull('C', NaN), null);
  assert.equal(deltaOrNull('C', null), null);
  assert.equal(deltaOrNull('C', undefined), null);
  assert.equal(deltaOrNull('C', 1), 1, 'a deep ITM call at exactly 1 is a reading');
  assert.equal(deltaOrNull('P', -0.25), -0.25);

  // And on the chain: the wrong-sign row is counted and never wins, even
  // though its |delta| is exactly the target.
  const s = skewOf([
    r('2026-11-20', 95, 'C', 0.26, -0.25),   // wrong sign, |δ| = 0.25 exactly
    r('2026-11-20', 105, 'C', 0.18, 0.40),
  ], null);
  const [pt] = s.points;
  assert.equal(pt!.call!.strike, 105);
  assert.equal(pt!.deltaMissing, 1);
});

test('a row with no IV is counted and never selected, however good its delta', () => {
  const s = skewOf([
    r('2026-11-20', 95, 'P', 0, -0.25),      // perfect delta, no IV
    r('2026-11-20', 90, 'P', 0.30, -0.15),
  ], null);
  const [pt] = s.points;
  assert.equal(pt!.put!.strike, 90);
  assert.equal(pt!.ivMissing, 1);
  assert.equal(pt!.deltaMissing, 0);
});

test('expiries are sorted and an expiry before the trade date is not on the curve', () => {
  const s = skewOf([
    r('2026-12-18', 95, 'P', 0.2, -0.25), r('2026-12-18', 105, 'C', 0.2, 0.25),
    r('2026-10-16', 95, 'P', 0.2, -0.25), r('2026-10-16', 105, 'C', 0.2, 0.25),  // expired
    r('2026-11-20', 95, 'P', 0.2, -0.25), r('2026-11-20', 105, 'C', 0.2, 0.25),
  ], '2026-10-21');
  assert.deepEqual(s.points.map((p) => p.expiry), ['2026-11-20', '2026-12-18']);
  // Without a trade date nothing is filtered and dte is null.
  const u = skewOf([r('2026-10-16', 95, 'P', 0.2, -0.25)], null);
  assert.equal(u.points.length, 1);
  assert.equal(u.points[0]!.dte, null);
});

test('the payload states its target, its units and its basis', () => {
  const s = skewOf([], null);
  assert.equal(s.targetDelta, 0.25);
  assert.equal(TARGET_DELTA, 0.25);
  assert.equal(s.ivUnits, 'FRACTION');
  assert.equal(s.basis, SKEW_BASIS);
  assert.match(s.basis, /nearest 0\.25/);
  assert.match(s.basis, /Nothing is interpolated/);
  assert.match(s.basis, /positive means puts are bid over calls/);
  assert.deepEqual(s.points, []);
});

test('the sign convention on the wire is the one the basis states', () => {
  // Puts bid over calls → positive. If someone flips the subtraction, the
  // sentence on the payload becomes a lie and this catches it.
  const s = skewOf([
    r('2026-11-20', 95, 'P', 0.30, -0.25),
    r('2026-11-20', 105, 'C', 0.20, 0.25),
  ], null);
  assert.ok(s.points[0]!.riskReversal! > 0);
  assert.match(SKEW_BASIS, /put IV minus call IV/);
});
