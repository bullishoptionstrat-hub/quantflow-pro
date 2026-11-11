/**
 * `analyse`: every detector for one symbol, SMT for a pair, one ordered list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bar } from '../src/market/bar';
import { KIND_ORDER, STRUCTURE_METHOD_VERSION, analyse, compareEvents } from '../src/structure/index';
import { methodVersionOf, resolveParams } from '../src/structure/params';
import { detectSwings } from '../src/structure/swings';
import { detectStructureShifts } from '../src/structure/structureShift';
import { detectRanges } from '../src/structure/range';
import { detectSmt } from '../src/structure/smt';
import { StructureInputError } from '../src/structure/types';
import { assertNotBackDated, bar, et, randomWalks } from './structureFixtures';

const [A, B] = randomWalks({
  symbols: ['SPY', 'QQQ'], tf: '5m', dates: ['2026-11-24', '2026-11-25'], seed: 11, starts: [580, 500],
}) as [Bar[], Bar[]];

test('the result names its symbol, pair, timeframe, as-of and version', () => {
  const r = analyse(A, { pair: B });
  assert.equal(r.status, 'OK');
  if (r.status !== 'OK') return;
  assert.equal(r.symbol, 'SPY');
  assert.equal(r.pairSymbol, 'QQQ');
  assert.equal(r.tf, '5m');
  assert.equal(r.asOf, Math.max(A[A.length - 1].closedAt, B[B.length - 1].closedAt), 'as-of is the last close supplied, not the clock');
  assert.equal(r.methodVersion, STRUCTURE_METHOD_VERSION);
  assert.ok(r.events.every((e) => e.methodVersion === r.methodVersion));
  assert.ok(r.events.every((e) => e.knownAt <= r.asOf));
  assert.deepEqual(r.notComputed.map((n) => n.status), ['UNMEASURABLE', 'UNMEASURABLE', 'UNMEASURABLE', 'UNMEASURABLE']);
  assertNotBackDated('analyse', r.events);
});

test('events are in knownAt order, ties broken by a fixed kind order, deterministically', () => {
  const r1 = analyse(A, { pair: B });
  const r2 = analyse(A, { pair: B });
  assert.deepEqual(r1, r2, 'same bars, same answer');
  if (r1.status !== 'OK') return;
  for (let i = 1; i < r1.events.length; i++) assert.ok(compareEvents(r1.events[i - 1], r1.events[i]) < 0);
  assert.equal(new Set(KIND_ORDER).size, KIND_ORDER.length);
});

test('without a pair there is no SMT, and the pair symbol is null', () => {
  const r = analyse(A);
  assert.ok(r.status === 'OK');
  assert.equal(r.pairSymbol, null);
  assert.ok(!r.events.some((e) => e.kind.startsWith('SMT_')));
});

test('parameter overrides are applied and named in the version', () => {
  const r = analyse(A, { params: { pivotLeft: 3, pivotRight: 3 } });
  assert.ok(r.status === 'OK');
  assert.equal(r.methodVersion, methodVersionOf(resolveParams({ pivotLeft: 3, pivotRight: 3 })));
  assert.notEqual(r.methodVersion, STRUCTURE_METHOD_VERSION);
});

test('refused, with every reason, rather than computed over bad input', () => {
  const refused = (r: ReturnType<typeof analyse>) => (r.status === 'REFUSED' ? r.reasons : []);
  assert.deepEqual(refused(analyse([])), ['no bars']);
  assert.ok(refused(analyse([A[1], A[0]])).some((r) => /is not after the previous bar/.test(r)));
  assert.ok(refused(analyse([{ ...A[0], h: NaN }])).some((r) => /h is not a finite number/.test(r)));
  assert.ok(refused(analyse(A, { params: { pivotRight: 0 } })).some((r) => /params: pivotRight must be/.test(r)));
  assert.ok(refused(analyse(A, { params: { atrPeriods: 3 } as never })).some((r) => /unknown parameter atrPeriods/.test(r)));
  assert.ok(refused(analyse(A, { pair: [] })).includes('pair: no bars'));
  assert.ok(refused(analyse(A, { pair: A })).some((r) => /pair symbol SPY is the analysed symbol/.test(r)));
  const q1 = [bar('QQQ', '1m', A[0].tOpen, 500, 501, 499, 500)];
  assert.ok(refused(analyse(A, { pair: q1 })).some((r) => /pair timeframe 1m differs from 5m/.test(r)));
});

test('consumers refuse swings computed under other parameters rather than mix two methods', () => {
  const wide = resolveParams({ pivotLeft: 3, pivotRight: 3 });
  const swings = detectSwings(A, wide);
  assert.ok(swings.length > 0);
  assert.throws(() => detectStructureShifts(A, swings), StructureInputError);
  assert.throws(() => detectRanges(swings), StructureInputError);
  assert.throws(() => detectSmt(A, B, swings, detectSwings(B)), /was computed under/);
  assert.doesNotThrow(() => detectStructureShifts(A, swings, wide), 'the same parameters are fine');
});

test('a single bar is analysable and says what it cannot yet measure', () => {
  const r = analyse([bar('SPY', '5m', et('2026-11-24', 9, 30), 580, 581, 579, 580.5)]);
  assert.ok(r.status === 'OK');
  assert.deepEqual(r.events.map((e) => e.kind), ['DISPLACEMENT_UNMEASURABLE']);
});
