/**
 * The closed-bar contract in `src/market/bar.ts`: refusal, not repair.
 *
 * A bar whose high is below its close is not a bar with a typo. It is evidence
 * the source is reporting something other than what the fields claim, and
 * "fixing" it would put a number nobody observed underneath every structure
 * event built on it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bar, barRefusals, validateBar, validateSeries } from '../src/market/bar';
import { bar, et } from './structureFixtures';

const OK = bar('SPY', '1m', et('2026-11-23', 10, 0), 100, 101, 99, 100.5);

test('a well-formed closed bar is accepted', () => {
  assert.deepEqual(validateBar(OK), { ok: true });
  assert.deepEqual(validateBar({ ...OK, v: null }), { ok: true }, 'an unreported volume is null, and allowed');
});

test('non-finite numbers are refused, and relational checks wait until the numbers are readable', () => {
  for (const k of ['o', 'h', 'l', 'c', 'tOpen', 'closedAt'] as const) {
    for (const v of [NaN, Infinity, -Infinity, '100' as unknown as number]) {
      const r = barRefusals({ ...OK, [k]: v });
      assert.ok(r.includes(`${k} is not a finite number`), `${k} = ${String(v)}`);
      assert.ok(!r.some((x) => /is below max|is above min/.test(x)), 'no relational verdict on an unreadable number');
    }
  }
  assert.ok(barRefusals({ ...OK, v: NaN }).some((r) => /^v must be null/.test(r)));
  assert.ok(barRefusals({ ...OK, v: -1 }).some((r) => /^v must be null/.test(r)));
});

test('a high below max(open, close) and a low above min(open, close) are refused', () => {
  assert.ok(barRefusals({ ...OK, h: 100.4 }).some((r) => /h 100.4 is below max\(o, c\) 100.5/.test(r)));
  assert.ok(barRefusals({ ...OK, l: 100.2 }).some((r) => /l 100.2 is above min\(o, c\) 100/.test(r)));
  assert.deepEqual(validateBar({ ...OK, h: 100.5, l: 100 }), { ok: true }, 'equal to the body is allowed');
});

test('closedAt at or before tOpen is refused; so is a bar longer than its timeframe', () => {
  assert.ok(barRefusals({ ...OK, closedAt: OK.tOpen }).some((r) => /closedAt .* is not after tOpen/.test(r)));
  assert.ok(barRefusals({ ...OK, closedAt: OK.tOpen - 1 }).some((r) => /closedAt .* is not after tOpen/.test(r)));
  assert.ok(barRefusals({ ...OK, closedAt: OK.tOpen + 61_000 }).some((r) => /longer than a 1m bar/.test(r)));
  assert.deepEqual(validateBar({ ...OK, closedAt: OK.tOpen + 30_000 }), { ok: true }, 'a short bar at a session end is allowed');
});

test('identity and provenance fields are required; prices must be positive', () => {
  assert.ok(barRefusals({ ...OK, symbol: '' }).includes('symbol is missing'));
  assert.ok(barRefusals({ ...OK, source: ' ' }).includes('source is missing'));
  assert.ok(barRefusals({ ...OK, tf: '2m' }).some((r) => /tf "2m" is not one of/.test(r)));
  assert.ok(barRefusals({ ...OK, l: 0, o: 0.5, c: 0.5, h: 1 }).includes('l is not a positive price'));
  assert.deepEqual(barRefusals(null), ['not an object']);
});

test('a series is one symbol, one timeframe, in order, with no overlap; gaps are allowed', () => {
  const next = (b: Bar, dt: number): Bar => ({ ...b, tOpen: b.tOpen + dt, closedAt: b.closedAt + dt });
  assert.deepEqual(validateSeries([OK, next(OK, 60_000), next(OK, 600_000)]), { ok: true }, 'a nine-minute hole is a gap, not a fault');
  const refused = (xs: unknown[]) => { const v = validateSeries(xs); return v.ok ? [] : v.reasons; };
  assert.ok(refused([next(OK, 60_000), OK]).some((r) => /is not after the previous bar/.test(r)));
  assert.ok(refused([OK, OK]).some((r) => /is not after the previous bar/.test(r)));
  assert.ok(refused([OK, { ...next(OK, 30_000) }]).some((r) => /before the previous bar closed/.test(r)));
  assert.ok(refused([OK, { ...next(OK, 60_000), symbol: 'QQQ' }]).some((r) => /symbol QQQ differs/.test(r)));
  assert.ok(refused([OK, { ...next(OK, 300_000), tf: '5m', closedAt: OK.tOpen + 600_000 }]).some((r) => /tf 5m differs/.test(r)));
  assert.ok(refused([OK, { ...next(OK, 60_000), h: 1 }]).some((r) => /^bar 1: h 1 is below/.test(r)));
});
