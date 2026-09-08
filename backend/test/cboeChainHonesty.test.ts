/**
 * The Cboe delayed chain, and the difference between a skip and a claim.
 *
 * This connector reads one zero-filled value and uses it in two paths with
 * opposite requirements, which is how the defect survived a reading:
 *
 *   - GEX aggregation gates on `oi > 0 && gamma !== 0`, so a missing field
 *     there is correctly a *skip*. `Number(x) || 0` is fine for that.
 *   - The unusual-activity list gates on `volume > 0 && last > 0` alone, and
 *     then **publishes** `openInterest`. The same zero reached the wire, and
 *     `UnusualActivity.tsx` renders it with `.toLocaleString()` — so a row
 *     Cboe answered without open interest showed the definite claim `0`.
 *
 * `volumeToOI` was the mirror image: the connector sent `Infinity`, and
 * `JSON.stringify(Infinity)` is `null`, so the wire had been carrying a null
 * that both sides typed as a number. The frontend's `Number.isFinite` check
 * rendered it as `new` — correct, by way of a path neither side declared.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const OSI = 'SPY261218C00580000'; // SPY 2026-12-18 C 580

function load(rows: unknown[], top: Record<string, unknown> = {}) {
  const resolved = require.resolve('../src/ingestion/connectors/cboeOptions');
  delete require.cache[resolved];
  const axios = require('axios');
  const realGet = axios.default?.get ?? axios.get;
  const get = async () => ({ data: { data: { current_price: 580, iv30: 0.18, options: rows, ...top } } });
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

/** A row that clears the unusual gate: volume over max(oi, 250), with a last. */
const unusualRow = (over: Record<string, unknown> = {}) => ({
  option: OSI, open_interest: 400, gamma: 0.02, volume: 5000,
  last_trade_price: 3.2, bid: 3.1, ask: 3.3, iv: 0.22, delta: 0.45,
  last_trade_time: '2026-12-01T18:30:00Z', ...over,
});

test('a complete row is published as sent', async () => {
  const cboe = load([unusualRow()]);
  try {
    const snap = await cboe.fetchCboeChain('SPY');
    const [u] = snap.unusual;
    assert.equal(u.openInterest, 400);
    assert.equal(u.bid, 3.1);
    assert.equal(u.iv, 0.22);
    assert.ok(Math.abs(u.volumeToOI - 12.5) < 1e-9);
    assert.equal(snap.iv30, 0.18);
  } finally { cboe.restore(); }
});

test('an open interest the row did not carry is null, not a zero in the table', async () => {
  const cboe = load([unusualRow({ open_interest: undefined })]);
  try {
    const snap = await cboe.fetchCboeChain('SPY');
    const [u] = snap.unusual;
    assert.ok(u, 'a missing open interest does not disqualify the row — volume does the gating');
    assert.equal(u.openInterest, null, 'rendered with .toLocaleString(); 0 is a claim');
    assert.equal(u.volumeToOI, null, 'and no ratio can be computed from it');
  } finally { cboe.restore(); }
});

test('a real zero open interest still reads as new, not as unknown', async () => {
  // The two must stay distinguishable: `new` means the whole day's volume
  // opened positions, `—` means Cboe did not say.
  const cboe = load([unusualRow({ open_interest: 0 })]);
  try {
    const [u] = (await cboe.fetchCboeChain('SPY')).unusual;
    assert.equal(u.openInterest, 0, 'zero open interest is a real market state');
    assert.equal(u.volumeToOI, null, 'nothing to divide by, which the UI renders as `new`');
  } finally { cboe.restore(); }
});

test('the quote and greeks are absent rather than zero', async () => {
  const cboe = load([unusualRow({ bid: undefined, ask: undefined, iv: undefined, delta: undefined })]);
  try {
    const [u] = (await cboe.fetchCboeChain('SPY')).unusual;
    assert.equal(u.bid, null);
    assert.equal(u.ask, null);
    assert.equal(u.iv, null, 'an IV of 0 is not "no IV"');
    assert.equal(u.delta, null, 'a delta of 0 means the opposite of unknown');
  } finally { cboe.restore(); }
});

test('an absent iv30 is null rather than a flat volatility surface', async () => {
  const cboe = load([unusualRow()], { iv30: undefined });
  try {
    assert.equal((await cboe.fetchCboeChain('SPY')).iv30, null);
  } finally { cboe.restore(); }
});

test('nothing on the wire is Infinity, because JSON has no word for it', async () => {
  // `JSON.stringify(Infinity)` is `null`. Sending it meant the declared type
  // and the transmitted value disagreed on every row with no open interest.
  const cboe = load([unusualRow({ open_interest: 0 }), unusualRow({ open_interest: 400 })]);
  try {
    const snap = await cboe.fetchCboeChain('SPY');
    const raw = JSON.stringify(snap);
    assert.ok(!raw.includes('Infinity'), 'no literal Infinity in the payload');
    for (const u of snap.unusual) {
      assert.ok(u.volumeToOI === null || Number.isFinite(u.volumeToOI),
        'every published ratio is either a finite number or an explicit null');
    }
  } finally { cboe.restore(); }
});

test('the GEX path still skips a contract it cannot weigh', async () => {
  // The other half of the same read. A missing open interest or gamma must not
  // enter the aggregation as a zero *or* as a null — it is simply not a
  // contract this computation can include.
  const cboe = load([
    unusualRow({ open_interest: undefined, volume: 10 }),
    unusualRow({ gamma: undefined, volume: 10 }),
    unusualRow({ volume: 10 }),
  ]);
  try {
    const snap = await cboe.fetchCboeChain('SPY');
    assert.equal(snap.gex.length, 1, 'only the fully-specified contract is weighed');
    assert.equal(snap.gex[0].callOI, 400, 'and it is not double-counted');
  } finally { cboe.restore(); }
});

test('a chain with no spot is refused outright', async () => {
  // Every GEX figure is scaled by spot squared, so a snapshot without one is
  // not a partial answer.
  const cboe = load([unusualRow()], { current_price: undefined, close: undefined });
  try {
    assert.equal(await cboe.fetchCboeChain('SPY'), null);
  } finally { cboe.restore(); }
});
