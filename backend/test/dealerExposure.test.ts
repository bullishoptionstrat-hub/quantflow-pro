/**
 * Delta exposure, the same-day lens, and a gamma flip that was never one.
 *
 * Three claims are added to the chain here, and the interesting part of each is
 * what it refuses to claim.
 *
 *   - **DEX** imposes no sign convention, unlike GEX. Gamma is positive for
 *     calls and puts alike, so `gex`'s call-positive / put-negative split is an
 *     assumption *expressed* as arithmetic. Delta already carries its sign, so
 *     imposing a second one flips the puts twice.
 *   - **0DTE** is `null` when the chain has no same-day expiry, which is the
 *     ordinary case. Measured against live chains on 2026-09-15: SPY 310
 *     same-day contracts, SPX 484, AAPL none at all.
 *   - **The gamma flip is not reported.** The old rule — first per-strike sign
 *     change in a strike-sorted array — returned 80 on a real AAPL chain with
 *     spot at 331.75: a strike 76% below spot holding $1,420 of $1.45bn.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function load(rows: unknown[], top: Record<string, unknown> = {}) {
  const resolved = require.resolve('../src/ingestion/connectors/cboeOptions');
  delete require.cache[resolved];
  const axios = require('axios');
  const realGet = axios.default?.get ?? axios.get;
  const get = async () => ({
    data: { data: { current_price: 100, iv30: 0.2, options: rows, ...top } },
  });
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

/** OSI for one contract: 100 strike, given right and expiry. */
const osi = (right: 'C' | 'P', yymmdd: string, strike = 100) =>
  `SPY${yymmdd}${right}${String(strike * 1000).padStart(8, '0')}`;

const row = (right: 'C' | 'P', over: Record<string, unknown> = {}) => ({
  option: osi(right, '260916'), open_interest: 10, gamma: 0.01,
  delta: right === 'C' ? 0.5 : -0.5, volume: 0, last_trade_price: 1, ...over,
});

test('delta keeps its own sign, and gamma is given one', async () => {
  // The whole distinction, in one assertion. A call and a put with equal and
  // opposite deltas cancel in DEX; their gammas — both positive — do not
  // cancel in GEX, because the convention subtracts the put side.
  const cboe = load([row('C'), row('P')]);
  try {
    const snap = await cboe.fetchCboeChain('SPY');
    const [lvl] = snap.gex;
    // delta x OI x 100 x spot, summed: (0.5 + -0.5) x 10 x 100 x 100 = 0
    assert.equal(lvl.dex, 0, 'equal and opposite deltas cancel');
    // gamma x OI x 100 x spot^2 x 0.01, calls plus and puts minus: cancels too,
    // but only because the convention imposed the minus.
    assert.equal(lvl.gex, 0);
    assert.equal(lvl.callDelta, 0.5);
    assert.equal(lvl.putDelta, -0.5);
  } finally { cboe.restore(); }
});

test('a put alone makes DEX negative without any sign being applied', async () => {
  // If a second sign were imposed on puts — the way `gex` does — this would
  // come out positive, and the book would read as the mirror of the tape.
  const cboe = load([row('P')]);
  try {
    const snap = await cboe.fetchCboeChain('SPY');
    assert.equal(snap.gex[0].dex, -0.5 * 10 * 100 * 100);
    assert.ok(snap.gex[0].dex < 0, 'a long put position is short delta');
  } finally { cboe.restore(); }
});

test('dollar delta uses one factor of spot, dollar gamma two', async () => {
  // Delta is already a share count per contract, so one spot makes it dollars.
  // Gamma is a rate of change of delta, so the second spot is what turns a $1
  // move into a 1% one. Getting this wrong scales DEX by the spot price.
  const cboe = load([row('C', { delta: 1, gamma: 1, open_interest: 1 })]);
  try {
    const snap = await cboe.fetchCboeChain('SPY');
    const [lvl] = snap.gex;
    assert.equal(lvl.dex, 1 * 1 * 100 * 100);              // 10,000
    assert.equal(lvl.gex, 1 * 1 * 100 * 100 * 100 * 0.01); // 10,000 too, at spot 100
    // Same number at spot 100 by coincidence; the ratio is what matters.
    assert.equal(lvl.gex / lvl.dex, 100 * 0.01);
  } finally { cboe.restore(); }
});

test('a contract with no delta is counted, not zero-filled', async () => {
  // `?? 0` was the first version. An option's delta is never actually zero, so
  // that recorded a contract as having no directional exposure — and zero
  // being the additive identity made it invisible in the sum.
  const cboe = load([row('C', { delta: null }), row('C', { delta: 0.5 })]);
  try {
    const snap = await cboe.fetchCboeChain('SPY');
    const [lvl] = snap.gex;
    assert.equal(lvl.dexMissing, 1, 'the absent delta is reported');
    assert.equal(lvl.dex, 0.5 * 10 * 100 * 100, 'and excluded from the sum');
    // It still belongs to the gamma aggregation, which never needed its delta.
    assert.equal(lvl.callOI, 20);
  } finally { cboe.restore(); }
});

test('0DTE is the chain\'s own date, and null when there is none', async () => {
  // AAPL on 2026-09-15 had its nearest expiry the *next* day. Showing that as
  // "0DTE" would relabel tomorrow as today for most of the market.
  const cboe = load([row('C')], { last_trade_time: '2026-09-15T15:59:59' });
  try {
    const snap = await cboe.fetchCboeChain('SPY');
    assert.equal(snap.tradeDate, '2026-09-15');
    assert.equal(snap.zeroDte, null, 'the only expiry is 2026-09-16');
  } finally { cboe.restore(); }
});

test('a same-day expiry produces its own aggregation', async () => {
  const sameDay = { option: osi('C', '260915'), open_interest: 10, gamma: 0.01, delta: 0.5, volume: 0, last_trade_price: 1 };
  const cboe = load([row('C'), sameDay], { last_trade_time: '2026-09-15T15:59:59' });
  try {
    const snap = await cboe.fetchCboeChain('SPY');
    assert.equal(snap.zeroDte.expiry, '2026-09-15');
    assert.equal(snap.zeroDte.contractCount, 1);
    // The full chain still holds both; the lens is a restriction, not a split.
    assert.equal(snap.gex[0].callOI, 20);
    assert.equal(snap.zeroDte.levels[0].callOI, 10);
  } finally { cboe.restore(); }
});

test('the trade date comes from the vendor, never from this process', async () => {
  // The server's clock can be in any timezone and the question — "does this
  // expire today?" — is asked in the market's.
  const cboe = load([row('C')], { last_trade_time: undefined });
  try {
    const snap = await cboe.fetchCboeChain('SPY');
    assert.equal(snap.tradeDate, null, 'no vendor date, no claim about today');
    assert.equal(snap.zeroDte, null);
  } finally { cboe.restore(); }
});

test('the gamma flip is not published, and says why', () => {
  // Three candidate numbers for one label and no established basis to choose:
  // the old rule gave 80, a cumulative-sum crossing gives 100, and the method
  // the vendors describe is a third computation. `null` with a reason, the way
  // `putCallUnavailable` and `INSUFFICIENT_SAMPLE` already work here.
  const route = readFileSync(join(__dirname, '..', 'src', 'routes', 'gex.ts'), 'utf8');
  assert.match(route, /flipStrike: null/);
  assert.match(route, /flipUnavailable/);
  assert.ok(!/levels\[i\]\.gex > 0 && levels\[i \+ 1\]\.gex < 0/.test(route),
    'the first-sign-change rule must not come back');
});

test('nothing fabricates a gamma profile any more', () => {
  // `generateSyntheticGEX` built 31 strikes from Math.random() over a 2024
  // spot map and a 60s timer refreshed four symbols with it — into the same
  // cache `getGEXLevels` reads as "the last real chain".
  const index = readFileSync(join(__dirname, '..', 'src', 'ingestion', 'index.ts'), 'utf8');
  const code = index.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  assert.ok(!/generateSyntheticGEX/.test(code), 'the generator must stay deleted');
  assert.ok(!/spotMap/.test(code), 'and its hardcoded spot map with it');
});

test('every published assumption is stated, not implied', () => {
  // GEX is modelled: a public chain shows greeks and open interest and nothing
  // about who is short which contract. The call-positive / put-negative
  // convention *is* the dealer assumption, and it is the one nobody states.
  const route = readFileSync(join(__dirname, '..', 'src', 'routes', 'gex.ts'), 'utf8');
  for (const key of ['dealerPositioning', 'dex', 'greeks', 'secondOrder', 'staleness']) {
    assert.ok(route.includes(`${key}:`), `the payload should declare ${key}`);
  }
  assert.match(route, /assumptions: ASSUMPTIONS/, 'and ship them on the response');
});
