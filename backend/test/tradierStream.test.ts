/**
 * The Tradier options path, driven with Tradier's documented shapes.
 *
 * Nothing here has run against Tradier: no production token has been held in
 * this repo, and the hosts are refused by the egress policy. The payloads are
 * the documented ones (SEARCH_ONLY, 2026-10-24). What these tests can hold is
 * that the code does what the documentation says is needed — and that the
 * three defects that made the path deliver nothing cannot come back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  asArray, buildUniverse, contractFromRow, nearestExpirations, selectContracts,
  subscriptionFrame, timesaleToPrint, UNIVERSE_RULE, type TradierChainRow, type UniverseContract,
} from '../src/ingestion/tradierStream';
import { ingestPrint, drainIdle } from '../src/ingestion/flowEngineAdapter';

const INDEX = readFileSync(join(__dirname, '../src/ingestion/index.ts'), 'utf8');

function row(root: string, underlying: string, expiry: string, right: 'C' | 'P', strike: number): TradierChainRow {
  const yymmdd = expiry.slice(2).split('-').join('');
  return {
    symbol: `${root}${yymmdd}${right}${String(Math.round(strike * 1000)).padStart(8, '0')}`,
    underlying, root_symbol: root, strike, option_type: right === 'C' ? 'call' : 'put', expiration_date: expiry,
  };
}

// ─── Defect 1: the subscription named underlyings ──────────────────────────

test('the stream subscribes to option contracts, timesales only — never to the underlyings', () => {
  const frame = JSON.parse(subscriptionFrame(['SPY261016C00550000'], 'sid'));
  assert.deepEqual(frame.filter, ['timesale']);
  assert.deepEqual(frame.symbols, ['SPY261016C00550000']);
  const code = INDEX.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  assert.ok(!/symbols:\s*WATCHED_SYMBOLS/.test(code), 'the subscription must not be the underlying list');
  assert.match(code, /subscriptionFrame\(\[\.\.\.tradierUniverse\.keys\(\)\]/);
  assert.ok(!/processMarketTick/.test(code), 'the parser that dropped every timesale is gone');
});

// ─── Contract selection ─────────────────────────────────────────────────────

test('a chain row becomes a contract only when its fields agree with its OCC symbol', () => {
  const ok = contractFromRow(row('SPXW', 'SPX', '2026-10-16', 'C', 5500));
  assert.deepEqual(ok, {
    symbol: 'SPXW261016C05500000', underlying: 'SPX', root: 'SPXW', strike: 5500, right: 'C', expiry: '2026-10-16',
  });
  const bad = (o: Partial<TradierChainRow>) => contractFromRow({ ...row('SPY', 'SPY', '2026-10-16', 'C', 550), ...o });
  assert.equal(bad({ strike: 551 }), null, 'strike disagrees with the symbol');
  assert.equal(bad({ option_type: 'put' }), null, 'right disagrees');
  assert.equal(bad({ expiration_date: '2026-10-23' }), null, 'expiry disagrees');
  assert.equal(bad({ root_symbol: 'SPYW' }), null, 'root disagrees');
  assert.equal(bad({ expiration_date: '20261016' }), null, 'an unreadable expiry is not repaired');
  assert.equal(bad({ underlying: undefined }), null, 'no underlying, no contract');
});

test('selection keeps the band, nearest first, capped, and is deterministic', () => {
  const rows: TradierChainRow[] = [];
  for (let k = 500; k <= 600; k++) for (const r of ['C', 'P'] as const) rows.push(row('SPY', 'SPY', '2026-10-16', r, k));
  rows.push({ symbol: 'garbage' });
  const { contracts, unreadable } = selectContracts(rows, 550);
  assert.equal(unreadable, 1);
  assert.equal(contracts.length, UNIVERSE_RULE.maxPerUnderlying);
  assert.ok(contracts.every((c) => Math.abs(c.strike - 550) / 550 <= UNIVERSE_RULE.strikeBand));
  assert.equal(contracts[0]!.strike, 550, 'nearest to spot first');
  assert.deepEqual(contracts.slice(0, 2).map((c) => c.right), ['C', 'P']);
  assert.deepEqual(selectContracts([...rows].reverse(), 550).contracts, contracts, 'input order does not matter');
  assert.deepEqual(selectContracts(rows, 0).contracts, [], 'no spot, no band, no universe');

  // The band on its own, below the cap — above it the cap would hide a
  // missing band, which is how the first draft of this test passed without it.
  const sparse: TradierChainRow[] = [];
  for (let k = 500; k <= 600; k += 5) sparse.push(row('SPY', 'SPY', '2026-10-16', 'C', k));
  const inBand = selectContracts(sparse, 550).contracts.map((c) => c.strike).sort((a, b) => a - b);
  assert.deepEqual(inBand, [525, 530, 535, 540, 545, 550, 555, 560, 565, 570, 575]);
});

test('expirations: on or after today, readable, deduplicated, nearest first', () => {
  assert.deepEqual(
    nearestExpirations(['2026-10-30', '2026-10-16', 'nope', '2026-10-01', '2026-10-16', '2026-10-23'], '2026-10-16', 2),
    ['2026-10-16', '2026-10-23'],
  );
});

test('the universe for SPX holds SPX and SPXW as different contracts, and a failure is recorded, not hidden', async () => {
  const get = async (path: string, p: Record<string, string>) => {
    if (path === '/v1/markets/quotes') {
      // Tradier's quirk: a single result arrives as an object, not an array.
      return { quotes: { quote: [{ symbol: 'SPX', last: 5500 }, { symbol: 'QQQ', last: 480 }] } };
    }
    if (path === '/v1/markets/options/expirations') {
      if (p.symbol === 'QQQ') throw Object.assign(new Error('Request failed with status code 403'), { response: { status: 403, data: 'Forbidden' } });
      return { expirations: { date: '2026-10-16' } };
    }
    return { options: { option: [row('SPX', 'SPX', '2026-10-16', 'C', 5500), row('SPXW', 'SPX', '2026-10-16', 'C', 5500)] } };
  };
  const { contracts, report } = await buildUniverse(get, ['SPX', 'QQQ', 'NVDA'], '2026-10-01');
  assert.deepEqual([...contracts.keys()].sort(), ['SPX261016C05500000', 'SPXW261016C05500000']);
  assert.equal(report.perUnderlying.SPX, 2);
  assert.match(report.failures.QQQ ?? '', /chain request failed|403/);
  assert.match(report.failures.NVDA ?? '', /no last price/);
  assert.deepEqual(asArray(undefined), []);
});

// ─── Defect 2: timesales were dropped, trades had no quote ─────────────────

const SPXW: UniverseContract = {
  symbol: 'SPXW261016C05500000', underlying: 'SPX', root: 'SPXW', strike: 5500, right: 'C', expiry: '2026-10-16',
};
const universe = new Map([[SPXW.symbol, SPXW]]);
/** The documented timesale payload: strings throughout, `last` not `price`. */
const ts = (o: Record<string, unknown> = {}) => ({
  type: 'timesale', symbol: SPXW.symbol, exch: 'C', bid: '12.10', ask: '12.40', last: '12.40',
  size: '25', date: '1792166400000', seq: 4521, flag: '', cancel: false, correction: false, session: 'normal', ...o,
});

test('a documented timesale becomes a print carrying its own quote', () => {
  const out = timesaleToPrint(ts(), universe);
  assert.ok('print' in out);
  const p = out.print;
  assert.equal(p.price, 12.4);
  assert.equal(p.size, 25);
  assert.equal(p.bid, 12.1);
  assert.equal(p.ask, 12.4);
  assert.equal(p.ts, 1792166400000);
  assert.equal(p.quoteTs, p.ts, 'the quote is published under the instant the vendor stated');
  assert.equal(p.symbol, 'SPX');
  assert.equal(p.root, 'SPXW');
  assert.equal(p.source, 'tradier');
});

test('cancels, corrections, unsubscribed and malformed records are refused by name', () => {
  const r = (o: Record<string, unknown>) => {
    const out = timesaleToPrint(ts(o), universe);
    return 'refused' in out ? out.refused : 'PRINT';
  };
  assert.equal(r({ cancel: true }), 'CANCEL');
  assert.equal(r({ cancel: 'true' }), 'CANCEL');
  assert.equal(r({ correction: true }), 'CORRECTION');
  assert.equal(r({ symbol: 'SPY261016C00550000' }), 'NOT_SUBSCRIBED');
  assert.equal(r({ last: '0' }), 'MALFORMED');
  assert.equal(r({ size: '2.5' }), 'MALFORMED');
  assert.equal(r({ date: undefined }), 'MALFORMED', 'no trade time is not stamped with receipt time');
  assert.equal(r({ type: 'trade', price: '12.40' }), 'NOT_TIMESALE');
  const noQuote = timesaleToPrint(ts({ bid: undefined, ask: undefined }), universe);
  assert.ok('print' in noQuote && noQuote.print.bid === undefined && noQuote.print.quoteTs === undefined);
});

// ─── Defect 3: identity was built from the underlying ──────────────────────

test('an SPX monthly and an SPXW weekly at one strike and date are two contracts', () => {
  // Same underlying, same expiry, strike and right, different roots. Built
  // from the underlying they were one OCC symbol — one NBBO book, one cluster.
  const base = {
    symbol: 'SPX', expiry: '2026-10-16', strike: 5500, right: 'C' as const, price: 12.4, size: 50,
    exchange: 'C', bid: 12.1, ask: 12.4, source: 'tradier', ts: Date.UTC(2026, 9, 14, 15, 0, 0),
  };
  ingestPrint({ ...base, id: 'r1', root: 'SPX' });
  ingestPrint({ ...base, id: 'r2', root: 'SPXW', ts: base.ts + 10 });
  const out = drainIdle(0).filter((e) => e.underlying === 'SPX' && e.print_ids?.some((i) => i === 'r1' || i === 'r2'));
  const legs = out.flatMap((e) => e.legs ?? [{ strike: e.strike }]);
  assert.equal(legs.length, 2, 'two contracts, not one merged');
});

test('a root the adapter cannot read is refused rather than replaced with the underlying', () => {
  // Asserted on what the engine later emits, not on `ingestPrint`'s return:
  // a first print returns nothing whether it was refused or admitted, because
  // signals are emitted when a burst closes — so that assertion could not
  // fail, and the first draft of this test passed without the gate.
  const at = Date.UTC(2026, 9, 14, 15, 5, 0);
  ingestPrint({
    id: 'badroot', symbol: 'SPX', root: 'spx w', expiry: '2026-10-16', strike: 5500, right: 'C',
    price: 12.4, size: 50, source: 'tradier', ts: at,
  });
  const out = drainIdle(0);
  assert.ok(!out.some((e) => e.print_ids?.includes('badroot')), 'the print was admitted');
});
