/**
 * The spot board's contract, held against the two connectors that write it.
 *
 * `SpotQuote` is declared in `twelveData.ts` and its docstring argues, at
 * length, that `volume` must be nullable because "no volume traded" is a
 * different claim from "this source does not report volume". The same file
 * then built the field as `parseInt(q.volume ?? 0)` in *both* of its write
 * paths, so the null it argues for was never once published. The rule was
 * written down and not enforced, which is the failure this file exists to fix.
 *
 * `change` and `changePct` were worse, because the type forbade the honest
 * answer: both were `number`, so neither connector could say "not sent" and
 * both wrote a zero. Finnhub returns `d`/`dp` as null for any symbol with no
 * previous close, and the ticker tape rendered that as `+0.00%` — a definite
 * reading, in the styling used for a real flat close.
 *
 * `price` deliberately stays non-nullable. A quote with no price is not a
 * quote, so both connectors drop the row rather than publish a null; the
 * distinction is that an unknown *change* still leaves a usable price.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** Load twelveData with axios and `ws` stubbed, and a key present. */
function load(quotes: Record<string, unknown>) {
  const resolved = require.resolve('../src/ingestion/connectors/twelveData');
  const wsPath = require.resolve('ws');
  delete require.cache[resolved];

  const axios = require('axios');
  const realGet = axios.default?.get ?? axios.get;
  const get = async () => ({ data: quotes });
  if (axios.default) axios.default.get = get; else axios.get = get;

  // The connector opens a WebSocket on start. Stub it: this file is about what
  // the REST path writes into the cache, and a real socket would reach out.
  const wsMod = require('ws');
  const realWs = wsMod.default ?? wsMod;
  class StubSocket {
    on() { return this; }
    send() { /* never opened */ }
  }
  if (wsMod.default) wsMod.default = StubSocket; else require.cache[wsPath]!.exports = StubSocket;

  const prev = process.env.TWELVE_DATA_API_KEY;
  process.env.TWELVE_DATA_API_KEY = 'td-test-key';

  const mod = require('../src/ingestion/connectors/twelveData');
  return {
    ...mod,
    restore() {
      if (axios.default) axios.default.get = realGet; else axios.get = realGet;
      if (wsMod.default) wsMod.default = realWs; else require.cache[wsPath]!.exports = realWs;
      if (prev === undefined) delete process.env.TWELVE_DATA_API_KEY;
      else process.env.TWELVE_DATA_API_KEY = prev;
      delete require.cache[resolved];
    },
  };
}

/** Twelve Data's `/quote`, which sends every number as a string. */
const row = (over: Record<string, unknown> = {}) => ({
  SPY: {
    symbol: 'SPY', close: '612.40', change: '1.50', percent_change: '0.25',
    volume: '81234567', timestamp: 1_780_000_000, ...over,
  },
});

test('a volume Twelve Data did not send is null, exactly as the type promised', async () => {
  const td = load(row({ volume: undefined }));
  try {
    await td.startTwelveData();
    const q = td.getSpotQuotes().get('SPY');
    assert.ok(q, 'a missing volume does not invalidate a priced quote');
    assert.equal(q.volume, null, 'the field the docstring was written for');
    assert.equal(q.price, 612.4);
  } finally { td.restore(); }
});

test('a change Twelve Data did not send is null, not a flat zero', async () => {
  const td = load(row({ change: undefined, percent_change: undefined }));
  try {
    await td.startTwelveData();
    const q = td.getSpotQuotes().get('SPY');
    assert.ok(q);
    assert.equal(q.change, null);
    assert.equal(q.changePct, null, 'the tape must not print +0.00% for this');
  } finally { td.restore(); }
});

test('real zeros survive, because a flat close is a reading', async () => {
  const td = load(row({ change: '0', percent_change: '0', volume: '0' }));
  try {
    await td.startTwelveData();
    const q = td.getSpotQuotes().get('SPY');
    assert.equal(q.change, 0);
    assert.equal(q.changePct, 0);
    assert.equal(q.volume, 0, 'a genuinely untraded name reports zero volume');
  } finally { td.restore(); }
});

test('a row the batch answered without a price is not cached at all', async () => {
  // `parseFloat(q.close ?? q.price ?? 0)` put $0.00 into the spot cache, and
  // that cache feeds every connected socket's ticker tape. The Stooq failure,
  // a third time.
  const td = load(row({ close: undefined, price: undefined }));
  try {
    await td.startTwelveData();
    assert.equal(td.getSpotQuotes().size, 0, 'no price means no quote, not a $0.00 quote');
  } finally { td.restore(); }
});

test('the batch falls back to `price` when it sends no `close`', async () => {
  // Both keys are documented; only one arrives per plan. Dropping the row
  // when `close` is absent would silence a working feed, so the fallback is
  // kept — it is the `?? 0` on the end of it that was the defect.
  const td = load(row({ close: undefined, price: '99.5' }));
  try {
    await td.startTwelveData();
    assert.equal(td.getSpotQuotes().get('SPY').price, 99.5);
  } finally { td.restore(); }
});

test('an error row is skipped rather than published at zero', async () => {
  const td = load({ SPY: { status: 'error', message: 'symbol not found' } });
  try {
    await td.startTwelveData();
    assert.equal(td.getSpotQuotes().size, 0);
  } finally { td.restore(); }
});

test('getSpotPrice answers null for a symbol it has never quoted', async () => {
  // It answered `0`, and its one caller — the grader's mark source — defended
  // against that with `px > 0 ? px : undefined`. The sentinel is gone rather
  // than the guard kept: a zero mark grades every outcome against a price of
  // nothing, and the next caller does not inherit a guard written at the
  // previous one.
  const td = load(row());
  try {
    await td.startTwelveData();
    assert.equal(td.getSpotPrice('SPY'), 612.4);
    assert.equal(td.getSpotPrice('NOSUCH'), null);
  } finally { td.restore(); }
});
