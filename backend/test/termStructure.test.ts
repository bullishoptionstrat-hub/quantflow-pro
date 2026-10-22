/**
 * ROADMAP 5.4 — IV term structure from the chain, and IV rank refused.
 *
 * Term structure is a reading of one chain, so it ships. IV rank and
 * percentile need a year of history this deployment cannot legally
 * accumulate (CBOE_CDN_DELAYED_CHAIN is UNVERIFIED for PERSIST), so they are
 * `null` with the reason, the way the gamma flip is.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  termStructureOf, calendarDays, ivOrNull, IV_RANK_UNAVAILABLE, type IvPoint,
} from '../src/ingestion/termStructure';
import { classify } from '../src/provenance/rights';

const p = (expiry: string, strike: number, right: 'C' | 'P', iv: number | null): IvPoint =>
  ({ expiry, strike, right, iv });

test('ATM is the strike nearest spot with BOTH a call and a put IV', () => {
  // 100 is nearest spot (101) but only has a call; 105 has both.
  const ts = termStructureOf([
    p('2026-10-16', 100, 'C', 0.2),
    p('2026-10-16', 105, 'C', 0.22), p('2026-10-16', 105, 'P', 0.26),
    p('2026-10-16', 90, 'C', 0.3), p('2026-10-16', 90, 'P', 0.31),
  ], 101, '2026-09-24');
  const [pt] = ts.points;
  assert.equal(pt!.atmStrike, 105, 'one side alone is skew, not level');
  assert.equal(pt!.callIv, 0.22);
  assert.equal(pt!.putIv, 0.26);
  assert.equal(pt!.atmIv, 0.24);
  assert.ok(Math.abs(pt!.distancePct! - 4 / 101) < 1e-12, 'distance from spot is published');
});

test('a tie between two strikes goes to the lower, whatever the row order', () => {
  const rows = [
    p('2026-10-16', 105, 'C', 0.2), p('2026-10-16', 105, 'P', 0.2),
    p('2026-10-16', 95, 'C', 0.3), p('2026-10-16', 95, 'P', 0.3),
  ];
  assert.equal(termStructureOf(rows, 100, null).points[0]!.atmStrike, 95);
  assert.equal(termStructureOf([...rows].reverse(), 100, null).points[0]!.atmStrike, 95);
});

test('a zero or missing IV is counted as missing, never averaged in', () => {
  const ts = termStructureOf([
    p('2026-10-16', 100, 'C', 0), p('2026-10-16', 100, 'P', 0.25),
    p('2026-10-16', 110, 'C', null),
  ], 100, '2026-09-24');
  const [pt] = ts.points;
  assert.equal(pt!.ivMissing, 2);
  assert.equal(pt!.atmStrike, null, 'no strike carries both sides');
  assert.equal(pt!.atmIv, null);
  assert.equal(pt!.contracts, 3);
  assert.equal(ivOrNull(0), null);
  assert.equal(ivOrNull(-0.1), null);
  assert.equal(ivOrNull(Number.NaN), null);
  assert.equal(ivOrNull(0.18), 0.18);
});

test('expiries are sorted, dated from the chain\'s own trade date, and past ones dropped', () => {
  const ts = termStructureOf([
    p('2026-12-18', 100, 'C', 0.2), p('2026-12-18', 100, 'P', 0.2),
    p('2026-09-23', 100, 'C', 0.2), p('2026-09-23', 100, 'P', 0.2),
    p('2026-10-16', 100, 'C', 0.2), p('2026-10-16', 100, 'P', 0.2),
  ], 100, '2026-09-24');
  assert.deepEqual(ts.points.map((x) => x.expiry), ['2026-10-16', '2026-12-18']);
  assert.deepEqual(ts.points.map((x) => x.dte), [22, 85]);
});

test('with no trade date, dte is null and nothing is filtered by it', () => {
  const ts = termStructureOf([p('2020-01-17', 100, 'C', 0.2), p('2020-01-17', 100, 'P', 0.2)], 100, null);
  assert.equal(ts.points.length, 1);
  assert.equal(ts.points[0]!.dte, null);
});

test('calendar days are civil-date arithmetic, immune to DST', () => {
  assert.equal(calendarDays('2026-10-30', '2026-11-02'), 3, 'across the fall-back weekend');
  assert.equal(calendarDays('2026-03-06', '2026-03-09'), 3, 'across spring-forward');
  assert.equal(calendarDays('not-a-date', '2026-03-09'), null);
});

test('the units label is held to a captured chain, not asserted', () => {
  const ts = termStructureOf([], 100, null);
  assert.equal(ts.ivUnits, 'FRACTION');
  assert.equal(ts.iv30Units, 'PERCENT');
  assert.match(ts.basis, /fractions/);

  // The evidence: on the recorded SPY chain, Cboe's own `iv30` and the
  // per-contract ATM IV nearest 30 DTE describe the same quantity, and the
  // label claims they differ by a factor of 100. If Cboe ever publishes both
  // in the same unit, the ratio collapses to ~1 and this fails — which is the
  // point. The 20% tolerance separates 100 from 1 by a wide margin and allows
  // for the 30-DTE point not being exactly 30 days, or for iv30 being
  // interpolated between two expiries.
  const vol = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'vol.json'), 'utf8'));
  assert.equal(vol.termStructure.ivUnits, 'FRACTION', 'fixture predates the label — re-capture');
  assert.ok(typeof vol.iv30 === 'number' && vol.iv30 > 0, 'fixture should carry iv30');
  const pts = (vol.termStructure.points as Array<{ dte: number | null; atmIv: number | null }>)
    .filter((p) => p.dte !== null && p.atmIv !== null);
  const near30 = pts.reduce((a, b) => (Math.abs(b.dte! - 30) < Math.abs(a.dte! - 30) ? b : a));
  assert.ok(Math.abs(near30.dte! - 30) <= 7, `nearest point to 30 DTE is ${near30.dte} days out`);
  const ratio = vol.iv30 / near30.atmIv!;
  assert.ok(ratio > 80 && ratio < 120,
    `iv30 ${vol.iv30} over ATM IV ${near30.atmIv} at ${near30.dte} DTE is ${ratio.toFixed(1)}, not ~100`);
});

test('IV rank is refused for the reason the registry gives', () => {
  // The refusal cites PERSIST being refused; hold that premise to the registry
  // so the sentence cannot outlive the fact it rests on.
  const persist = classify('CBOE_CDN_DELAYED_CHAIN', 'PERSIST', 'PRIVATE_RESEARCH');
  assert.equal(persist.allowed, false, 'if Cboe becomes persistable, this refusal must be revisited');
  assert.match(IV_RANK_UNAVAILABLE, /CBOE_CDN_DELAYED_CHAIN is UNVERIFIED for\s+PERSIST/);

  const route = readFileSync(join(__dirname, '..', 'src', 'routes', 'gex.ts'), 'utf8');
  assert.match(route, /router\.get\('\/vol'/);
  assert.match(route, /ivRank: null,/);
  assert.match(route, /ivPercentile: null,/);
  assert.match(route, /ivRankUnavailable: IV_RANK_UNAVAILABLE/);
});

// ─── Through the real connector ─────────────────────────────────────────────

function load(rows: unknown[], top: Record<string, unknown> = {}) {
  const resolved = require.resolve('../src/ingestion/connectors/cboeOptions');
  delete require.cache[resolved];
  const axios = require('axios');
  const realGet = axios.default?.get ?? axios.get;
  const get = async () => ({ data: { data: { current_price: 100, iv30: 0.2, options: rows, ...top } } });
  if (axios.default) axios.default.get = get; else axios.get = get;
  const mod = require('../src/ingestion/connectors/cboeOptions');
  return {
    ...mod,
    restore() {
      if (axios.default) axios.default.get = realGet; else axios.get = realGet;
      delete require.cache[resolved];
    },
  };
}
const osi = (right: 'C' | 'P', yymmdd: string, strike: number) =>
  `SPY${yymmdd}${right}${String(strike * 1000).padStart(8, '0')}`;

test('the connector builds the curve from every contract, open interest or not', async () => {
  const cboe = load([
    // No open interest: excluded from GEX, still a point on the IV curve.
    { option: osi('C', '261016', 100), open_interest: 0, gamma: 0, iv: 0.21, volume: 0 },
    { option: osi('P', '261016', 100), open_interest: 0, gamma: 0, iv: 0.23, volume: 0 },
  ], { last_trade_time: '2026-09-24T15:45:00' });
  try {
    const snap = await cboe.fetchCboeChain('SPY');
    const [pt] = snap.termStructure.points;
    assert.equal(pt.expiry, '2026-10-16');
    assert.equal(pt.dte, 22);
    assert.equal(pt.atmStrike, 100);
    assert.equal(pt.atmIv, 0.22);
  } finally { cboe.restore(); }
});
