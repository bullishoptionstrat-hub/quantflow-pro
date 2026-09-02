/**
 * FINDING #31 — the zero-sentinel sweep across the connector layer.
 *
 * Ninety-odd sites read an upstream field and substituted `0` when it was
 * absent: `?? 0`, `|| 0` (worse — it also collapses a legitimate 0 and a NaN),
 * and `parseFloat(x ?? 0)` (worse again — parseFloat is a prefix parser, so
 * "403 Forbidden" reads as 403).
 *
 * They are not all equally harmful, and this suite pins the ones that were,
 * grouped by what the fabricated zero actually reached:
 *
 *   1. CONTRACT IDENTITY. `strike ?? 0` was the worst of them. `occSymbol()`
 *      builds the flow engine's clustering key from the strike, so a row whose
 *      strike failed to parse was not merely mispriced — it was assigned a
 *      fabricated contract (strike part `00000000`) and every such row across
 *      every underlying clustered together as repeat activity on it.
 *
 *   2. A GRADED OUTCOME. `getSpotPrice()` returned 0 for a cache miss while
 *      typed `number`. The grader marks signals against it; a mark of 0 grades
 *      every position as a total loss.
 *
 *   3. THE WIRE. Prices, greeks and GEX levels published as 0 render in the
 *      same markup as real values.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ingestPrint, drainIdle, resetDaily, occSymbol, type RawPrint,
} from '../src/ingestion/flowEngineAdapter';
import { getSpotPrice } from '../src/ingestion/connectors/twelveData';
import { getMacroValue } from '../src/ingestion/connectors/fred';
import { num } from '../src/ingestion/parseNumeric';

function print(over: Partial<RawPrint> = {}): RawPrint {
  return {
    symbol: 'SPY', expiry: '2026-06-19', strike: 580, right: 'C',
    price: 3.25, size: 100, source: 'test',
    ...over,
  };
}

// ─── 1. Contract identity ───────────────────────────────────────────────────

/**
 * Signals are emitted on burst close, not per print, so `ingestPrint` alone
 * returns [] for anything — accepted or refused. `drainIdle(0)` closes the
 * burst, which is what makes the difference observable.
 */
function ingestAndDrain(p: RawPrint) {
  const direct = ingestPrint(p);
  return [...direct, ...drainIdle(0)];
}

test('the fabricated zero-strike contract symbol is what was at stake', () => {
  // Not an assertion about the fix — an assertion about the damage. Every row
  // whose strike failed to parse produced THIS key, regardless of underlying,
  // and the engine clusters on it.
  assert.equal(occSymbol('SPY', '2026-06-19', 'C', 0), 'SPY260619C00000000');
});

test('a print with strike 0 emits no signal, where a real one does', () => {
  resetDaily();
  const bad = ingestAndDrain(print({ symbol: 'ZEROSTRIKE', strike: 0, size: 900 }));
  assert.deepEqual(bad, [], 'a zero-strike print must not reach the engine');

  // The control. Same shape, real strike — this MUST emit, or the assertion
  // above would hold against an engine that emits nothing at all.
  resetDaily();
  const good = ingestAndDrain(print({ symbol: 'REALSTRIKE', strike: 580, size: 900 }));
  assert.ok(good.length > 0, 'a well-formed print must still produce a signal');
  assert.equal(good[0]?.strike, 580);
});

test('negative and NaN strikes are refused on the same terms', () => {
  for (const strike of [-5, NaN]) {
    resetDaily();
    assert.deepEqual(
      ingestAndDrain(print({ symbol: 'BADSTRIKE', strike, size: 900 })), [],
      `strike ${strike} must not reach the engine`,
    );
  }
});

// ─── 2. A graded outcome ────────────────────────────────────────────────────

test('getSpotPrice returns null for a cache miss, never 0', () => {
  // 0 would be a mark, and the grader measures outcomes against it: every
  // signal on an unknown symbol would grade as -100% with full confidence.
  assert.equal(getSpotPrice('NO-SUCH-SYMBOL'), null);
});

test('getMacroValue returns null for an uncached series, never 0', () => {
  // 0% is a real Fed Funds reading, so 0 could never have meant "unknown".
  assert.equal(getMacroValue('NO-SUCH-SERIES'), null);
});

// ─── 3. The parsing primitive the sweep is built on ─────────────────────────

test('num() refuses the prefix parse that parseFloat performs', () => {
  // The specific failure this replaces: `parseFloat('403 Forbidden')` is 403,
  // so an error body became a plausible-looking market number.
  assert.equal(num('403 Forbidden'), null);
  assert.equal(num('12abc'), null);
  assert.equal(num(''), null);
  assert.equal(num(null), null);
  assert.equal(num(undefined), null);
});

test('num() preserves a real zero, which is the whole point', () => {
  // `|| 0` and `?? 0` both erased the difference between "zero" and "absent".
  assert.equal(num(0), 0);
  assert.equal(num('0'), 0);
  assert.notEqual(num(0), num(undefined));
});

test('num() rejects non-finite values rather than passing them on', () => {
  assert.equal(num(NaN), null);
  assert.equal(num(Infinity), null);
});
