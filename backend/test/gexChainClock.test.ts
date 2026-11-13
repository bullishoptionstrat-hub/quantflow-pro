/**
 * `/api/gex` publishes the chain's own clock and spot, and says where each came
 * from.
 *
 * Both were dropped before this. The connector kept `spot` and wrote `asOf` as
 * `d.last_trade_time ?? new Date().toISOString()` — so a chain that arrived
 * with no clock was stamped with this server's receipt time, in the vendor's
 * field — and the route published neither, so a reader could not tell a chain
 * from two minutes ago from one from Friday.
 *
 * Driven through the real router with a populated Cboe snapshot, in the shapes
 * Cboe actually sends: `data.last_trade_time` carries **no zone** and is a New
 * York wall clock (measured 2026-11-11 against the file's own UTC generation
 * stamp; see `cboeTimeToIso`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

// Mock the vendor before the connector is imported, and import the connector
// the ingestion index holds, so the route reads the snapshot this test wrote.
const axios = require('axios');
let payload: Record<string, unknown> = {};
const fakeGet = async () => ({ data: payload });
if (axios.default) axios.default.get = fakeGet; else axios.get = fakeGet;

const cboe = require('../src/ingestion/connectors/cboeOptions') as typeof import('../src/ingestion/connectors/cboeOptions');
const gexRouter = require('../src/routes/gex').default;
const { classifySource } = require('../src/provenance/rights') as typeof import('../src/provenance/rights');
const { getUnusualActivity } = require('../src/ingestion/index') as typeof import('../src/ingestion/index');

const OSI = (sym: string, right: 'C' | 'P', strike: number) =>
  `${sym}261218${right}${String(strike * 1000).padStart(8, '0')}`;

const rows = (sym: string) => [
  { option: OSI(sym, 'C', 580), open_interest: 1200, gamma: 0.02, delta: 0.5, volume: 9000, last_trade_price: 3.1 },
  { option: OSI(sym, 'P', 570), open_interest: 900, gamma: 0.018, delta: -0.4, volume: 0, last_trade_price: 2.2 },
];

/** A Cboe-shaped file: a UTC generation stamp on top, the chain under `data`. */
async function loadChain(sym: string, data: Record<string, unknown>) {
  payload = { timestamp: '2026-11-11 20:01:15', data: { options: rows(sym), ...data } };
  return cboe.fetchCboeChain(sym);
}

async function gexFor(sym: string): Promise<any> {
  const app = express();
  app.use('/api/gex', gexRouter);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/gex?symbol=${sym}`);
    assert.equal(res.status, 200);
    return await res.json();
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('the chain\'s own clock and spot reach the wire, with where each came from', async () => {
  await loadChain('SPY', { current_price: 580.25, close: 579.1, last_trade_time: '2026-11-11T14:46:01' });
  const body = await gexFor('SPY');

  // 14:46:01 New York on 2026-11-11 (EST, UTC-5) is 19:46:01 UTC.
  assert.equal(body.asOf, '2026-11-11T19:46:01.000Z');
  assert.equal(body.asOfVendor, '2026-11-11T14:46:01', 'the vendor string, verbatim, beside the reading of it');
  assert.equal(body.spot, 580.25, 'the price the chain itself carried');
  assert.equal(body.spotField, 'current_price');
  assert.match(body.assumptions.clock, /New York/, 'the zone reading is stated, not implied');
  assert.match(body.assumptions.spot, /same chain/);
});

test('the as-of is the vendor\'s, whatever time this test runs', async () => {
  // A receipt-time stamp would land within seconds of now. The vendor's is a
  // fixed instant in the past, so the two cannot be confused.
  await loadChain('QQQ', { current_price: 501.5, last_trade_time: '2026-07-15T14:46:01' });
  const body = await gexFor('QQQ');
  assert.equal(body.asOf, '2026-07-15T18:46:01.000Z', 'EDT in July: UTC-4');
  assert.ok(Math.abs(Date.parse(body.asOf) - Date.now()) > 60 * 60_000);
  assert.ok(Date.parse(body.updatedAt) > Date.parse(body.asOf),
    '`updatedAt` is this server\'s response time and is a different field');
});

test('a chain with no clock publishes null, not this server\'s receipt time', async () => {
  await loadChain('NVDA', { current_price: 140 });
  const body = await gexFor('NVDA');
  assert.equal(body.realData, true, 'the chain is real; only its clock is missing');
  assert.equal(body.asOf, null);
  assert.equal(body.asOfVendor, null);
  assert.equal(body.spot, 140);
});

test('a chain with no current price takes its close, and says so', async () => {
  await loadChain('TSLA', { close: 251.4, last_trade_time: '2026-11-11T16:00:00' });
  const body = await gexFor('TSLA');
  assert.equal(body.spot, 251.4);
  assert.equal(body.spotField, 'close');
  assert.equal(body.asOf, '2026-11-11T21:00:00.000Z');
});

test('no chain: every chain-derived field is null — no zero spot, no clock, no rights', async () => {
  const body = await gexFor('NOCHAIN');
  assert.equal(body.realData, false);
  assert.equal(body.source, null);
  assert.equal(body.asOf, null);
  assert.equal(body.asOfVendor, null);
  assert.equal(body.spot, null, 'never 0: a zero spot would put every strike at +infinity percent');
  assert.equal(body.spotField, null);
  assert.equal(body.rights, null);
  assert.equal(body.delayedMinutes, null);
});

test('the rights class is the registry\'s answer, not the page\'s', async () => {
  await loadChain('AAPL', { current_price: 331.75, last_trade_time: '2026-11-11T14:46:01' });
  const body = await gexFor('AAPL');
  const expected = classifySource('cboe_options', 'DISPLAY');
  assert.deepEqual(body.rights, {
    datasetId: 'CBOE_CDN_DELAYED_CHAIN', display: expected.rightsClass, mode: expected.mode,
  });
  assert.equal(body.delayedMinutes, 15);
});

test('cboeTimeToIso reads the vendor\'s shape and refuses anything it cannot place', () => {
  const t = cboe.cboeTimeToIso;
  assert.equal(t('2026-11-11T14:46:01'), '2026-11-11T19:46:01.000Z');
  assert.equal(t('2026-11-11 14:46:01'), '2026-11-11T19:46:01.000Z', 'the space form Cboe uses on top');
  assert.equal(t('2026-11-11T14:46:01.250'), '2026-11-11T19:46:01.250Z');
  assert.equal(t('2026-12-01T18:30:00Z'), '2026-12-01T18:30:00.000Z', 'an explicit zone is read as given');
  assert.equal(t('2026-12-01T13:30:00-05:00'), '2026-12-01T18:30:00.000Z');
  // The spring-forward gap: 02:30 does not exist in New York on 2026-03-08.
  assert.equal(t('2026-03-08T02:30:00'), null);
  for (const bad of [undefined, null, '', 'garbage', 1_731_355_561, '2026-13-45T10:00:00',
    '2026-11-11T24:00:00', '2026-11-11', '11/11/2026 14:46:01']) {
    assert.equal(t(bad), null, `${String(bad)} is not a readable Cboe time`);
  }
});

test('the unusual-activity rows carry the same instant, not the zoneless string', async () => {
  // These rows were stamped with the vendor's raw string, which a browser
  // outside New York reads in its own zone.
  await loadChain('SPX', { current_price: 5800, last_trade_time: '2026-11-11T14:46:01' });
  const spx = getUnusualActivity('SPX');
  assert.ok(spx.length > 0, 'the 580 call clears the unusual gate');
  for (const r of spx) assert.equal(r.asOf, '2026-11-11T19:46:01.000Z');
});
