/**
 * SMT divergence: the definition in `src/structure/smt.ts`.
 *
 * Two symbols' swings are compared only when they line up in time, within a
 * stated tolerance, and only once the lagging symbol can no longer confirm a
 * closer candidate. A pair that does not line up is UNMEASURABLE — the tool
 * that "finds" divergence by comparing a swing with whichever swing of the
 * other symbol happens to be nearest, however far away, is finding noise.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bar } from '../src/market/bar';
import { SmtDivergenceEvent, SmtEvent, detectSmt } from '../src/structure/smt';
import { SwingEvent } from '../src/structure/swings';
import { StructureInputError } from '../src/structure/types';
import { assertPrefixStable, closedBy, et, fromHL, swingAt } from './structureFixtures';

const T0 = et('2026-11-23', 10, 0);
const flat = (symbol: string, n = 30): Bar[] =>
  fromHL(symbol, '1m', T0, Array.from({ length: n }, () => [101, 99] as [number, number]));
const A = flat('SPY');
const B = flat('QQQ');
const at = (bars: Bar[], e: { knownAt: number }) => bars.findIndex((b) => b.closedAt === e.knownAt);

/** A1 at 5, A2 at 15; B's two highs at `bPivots`, each confirmed two bars later. */
function highs(aPrices: [number, number], bPrices: number[], bPivots: number[]): [SwingEvent[], SwingEvent[]] {
  return [
    [swingAt(A, 'SWING_HIGH', 5, 7, aPrices[0]), swingAt(A, 'SWING_HIGH', 15, 17, aPrices[1])],
    bPivots.map((p, i) => swingAt(B, 'SWING_HIGH', p, p + 2, bPrices[i])),
  ];
}

const divergences = (ev: SmtEvent[]) => ev.filter((e): e is SmtDivergenceEvent => e.kind === 'SMT_DIVERGENCE');

test('A makes a higher high, B a lower one: a divergence led by A, known when B\'s window is settled', () => {
  const [sa, sb] = highs([100, 101], [200, 199.5], [6, 16]);
  const ev = detectSmt(A, B, sa, sb);
  const [d] = divergences(ev);
  assert.ok(d);
  assert.equal(d.side, 'HIGH');
  assert.equal(d.leader, 'SPY');
  assert.equal(d.laggard, 'QQQ');
  assert.equal(d.offsetBars, 1);
  // A2 pivots at 15; B bars opening up to 15 + 2 may hold a candidate, and a
  // pivot at 17 is confirmed or refuted by bar 19. That close is when the
  // comparison is known — not A2's own confirmation at 17.
  assert.equal(at(A, d), 19);
  assert.ok(d.evidence.some((r) => r.symbol === 'QQQ') && d.evidence.some((r) => r.symbol === 'SPY'));
});

test('the first swing of A has nothing to compare against, and says so', () => {
  const [sa, sb] = highs([100, 101], [200, 199.5], [6, 16]);
  const first = detectSmt(A, B, sa, sb).find((e) => e.kind === 'SMT_UNMEASURABLE' && e.anchor.pivotTOpen === A[5].tOpen);
  assert.ok(first && first.kind === 'SMT_UNMEASURABLE');
  assert.match(first.reason, /SPY has no previous confirmed swing high/);
  assert.equal(first.knownAt, A[7].closedAt);
});

test('agreement emits no divergence; an equal high is not a higher high', () => {
  assert.deepEqual(divergences(detectSmt(A, B, ...highs([100, 101], [200, 201], [6, 16]))), [], 'both made it');
  const [d] = divergences(detectSmt(A, B, ...highs([100, 100], [200, 201], [6, 16])));
  assert.equal(d.leader, 'QQQ', 'A only matched its high, so B led');
});

test('swings further apart than the tolerance are UNMEASURABLE from both sides, never compared', () => {
  const [sa, sb] = highs([100, 101], [200, 199.5], [6, 21]);
  const ev = detectSmt(A, B, sa, sb);
  assert.deepEqual(divergences(ev), []);
  const fromA = ev.find((e) => e.kind === 'SMT_UNMEASURABLE' && e.anchorSymbol === 'SPY' && e.anchor.pivotTOpen === A[15].tOpen);
  const fromB = ev.find((e) => e.kind === 'SMT_UNMEASURABLE' && e.anchorSymbol === 'QQQ');
  assert.ok(fromA && fromA.kind === 'SMT_UNMEASURABLE');
  assert.match(fromA.reason, /QQQ has no confirmed swing high within 2 bars of SPY's pivot/);
  assert.ok(fromB && fromB.kind === 'SMT_UNMEASURABLE');
  assert.match(fromB.reason, /SPY has no confirmed swing high within 2 bars of QQQ's pivot/);
  assert.equal(at(A, fromB), 25, 'B2 pivots at 21: A bars to 23 may hold a candidate, settled at 25');
});

test('an aligned B swing with no previous swing cannot be compared', () => {
  const [sa, sb] = highs([100, 101], [199.5], [16]);
  const e = detectSmt(A, B, sa, sb).find((x) => x.kind === 'SMT_UNMEASURABLE' && x.anchor.pivotTOpen === A[15].tOpen);
  assert.ok(e && e.kind === 'SMT_UNMEASURABLE');
  assert.match(e.reason, /QQQ's aligned swing high has no previous swing high/);
});

test('two equidistant candidates: the earlier is the aligned one', () => {
  const sa = [swingAt(A, 'SWING_HIGH', 5, 7, 100), swingAt(A, 'SWING_HIGH', 15, 17, 101)];
  const sb = [swingAt(B, 'SWING_HIGH', 6, 8, 200), swingAt(B, 'SWING_HIGH', 14, 16, 199), swingAt(B, 'SWING_HIGH', 16, 18, 201)];
  const [d] = divergences(detectSmt(A, B, sa, sb));
  assert.equal(d.b.current.pivotTOpen, B[14].tOpen);
  assert.equal(d.b.current.price, 199);
});

test('nothing is said before the other symbol\'s window can be settled', () => {
  const [sa, sb] = highs([100, 101], [200, 199.5], [6, 16]);
  assert.deepEqual(divergences(detectSmt(A, B.slice(0, 19), sa, sb.filter((s) => s.knownAt <= B[18].closedAt))), [],
    'B ends at bar 18; a candidate pivoting at 17 is not settled until 19');
  assert.equal(divergences(detectSmt(A, B.slice(0, 20), sa, sb)).length, 1);
});

test('lows mirror highs', () => {
  const sa = [swingAt(A, 'SWING_LOW', 5, 7, 100), swingAt(A, 'SWING_LOW', 15, 17, 99)];
  const sb = [swingAt(B, 'SWING_LOW', 5, 7, 200), swingAt(B, 'SWING_LOW', 15, 17, 200.5)];
  const [d] = divergences(detectSmt(A, B, sa, sb));
  assert.equal(d.side, 'LOW');
  assert.equal(d.leader, 'SPY', 'A made the lower low');
});

test('a pair must be two symbols at one timeframe', () => {
  assert.throws(() => detectSmt(A, A, [], []), StructureInputError);
  const b5 = B.map((b) => ({ ...b, tf: '5m' as const, closedAt: b.tOpen + 300_000 }));
  assert.throws(() => detectSmt(A, b5.filter((_, i) => i % 5 === 0), [], []), StructureInputError);
});

test('look-ahead guard, on a pair fed one close at a time', () => {
  for (const pivots of [[6, 16], [6, 21]]) {
    const [sa, sb] = highs([100, 101], [200, 199.5], pivots);
    assertPrefixStable(`smt/${pivots.join('-')}`, [...A, ...B].map((b) => b.closedAt), (asOf) =>
      detectSmt(closedBy(A, asOf), closedBy(B, asOf), sa.filter((s) => s.knownAt <= asOf), sb.filter((s) => s.knownAt <= asOf)));
  }
});
