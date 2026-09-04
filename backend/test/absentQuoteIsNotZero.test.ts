/**
 * An absent bid is not a bid of zero — and the difference decides a side.
 *
 * `missingIsNotZero.test.ts` closed this for the two connectors that were
 * examined closely at the time (`coinGecko.ts`, `cboe.ts`). Its guard names
 * those two files by hand, so the rule stopped at the edge of the list. The
 * four chain-snapshot connectors — `marketData.ts`, `yahoo.ts`,
 * `tastytrade.ts`, `schwab.ts` — were never in it, and all four filled an
 * absent quote with `?? 0`.
 *
 * That is not cosmetic here, because these connectors' bid/ask become the
 * contract's NBBO. `flowEngineAdapter.ingestPrint` publishes a quote when
 * `bid !== undefined && ask !== undefined && ask > 0 && ask >= bid` — and a
 * zero-filled bid is defined, so it passes. The book then holds `bid: 0`,
 * the midpoint becomes `ask / 2`, and essentially every fill lands above it.
 *
 * Measured through the real adapter, one print, isolated processes:
 *
 *     bid: 0         -> side=BUY_LEAN
 *     bid: undefined -> side=AMBIGUOUS
 *
 * So a strike the vendor simply did not quote was reported as directional
 * buying. `nbbo.ts` opens by saying side is AMBIGUOUS when the NBBO is
 * missing and that misclassified side is the #1 way flow tools lie; the
 * connector was defeating that contract before the engine could apply it, by
 * handing it a quote that did not exist.
 *
 * What is NOT changed, and is asserted below so it stays that way: a real bid
 * of zero. An option nobody is bidding on is a genuine market state, the
 * adapter still publishes it, and the lean the engine then draws from it is
 * the engine's own business. The defect was manufacturing that state, not
 * reacting to it. (The engine's `mid = ask / 2` is a weak reading for a real
 * zero bid too — recorded here as a finding, deliberately not changed: it
 * lives in the vendored engine, which must stay byte-identical to
 * `quantflow-modules/flow-engine`.)
 *
 * Coverage note: `marketData.ts` is exercised through its own mapping
 * function. The other three build their events inline inside a fetch loop
 * that needs credentials and a login, so they are held to the source-level
 * guard — the same standard `missingIsNotZero.test.ts` applies to cboe.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { quotesToFlow, type MDOptionQuote } from '../src/ingestion/connectors/marketData';

const CONNECTORS = join(__dirname, '..', 'src', 'ingestion', 'connectors');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');

/** The four connectors whose chain rows become a contract's NBBO. */
const CHAIN_CONNECTORS = ['marketData.ts', 'yahoo.ts', 'tastytrade.ts', 'schwab.ts'];

function row(over: Partial<MDOptionQuote> = {}): MDOptionQuote {
  return {
    symbol: 'SPY', strike: 550, expiration: '2026-06-19', callPut: 'C',
    bid: 4.9, ask: 5.1, last: 5, volume: 400, openInterest: 100,
    iv: 0.2, delta: 0.5, gamma: 0.01, theta: -0.1, vega: 0.2,
    ...over,
  };
}

test('a chain row the vendor did not quote carries no bid, not a zero bid', () => {
  const [event] = quotesToFlow([row({ bid: null })]);
  assert.ok(event, 'the row is still a trade — only the quote is unknown');
  assert.equal(event.bid, undefined, 'an absent bid must not reach the wire as 0');
  assert.equal(event.ask, 5.1, 'the side the vendor did quote is kept');
});

test('a real zero bid is kept, because nobody bidding is a market state', () => {
  const [event] = quotesToFlow([row({ bid: 0 })]);
  assert.ok(event);
  assert.equal(event.bid, 0, 'a quoted zero is data and must survive');
});

test('a row with no strike is not a contract', () => {
  // `strike: 0` named a contract that cannot exist, and it was classified,
  // scored and shown like any other.
  assert.deepEqual(quotesToFlow([row({ strike: null as unknown as number })]), []);
});

test('a row with no last price is not a print', () => {
  // premium was `last * volume * 100`, so an absent last priced the print at
  // $0 — which `legacyEventToPrint` then rejects for a reason that had
  // nothing to do with the actual failure.
  assert.deepEqual(quotesToFlow([row({ last: null })]), []);
});

test('an unknown volume is not "more than 50"', () => {
  assert.deepEqual(quotesToFlow([row({ volume: null })]), []);
});

test('no heat score is claimed without the quote it is mostly made of', () => {
  // Bid/ask displacement is 35 of the score's 100 points. Computed against a
  // zero-filled bid it read as maximum aggression; computed against
  // `undefined` it is NaN. Neither is a score.
  const [unquoted] = quotesToFlow([row({ bid: null })]);
  assert.equal(unquoted.heatScore, undefined);

  const [quoted] = quotesToFlow([row()]);
  assert.equal(typeof quoted.heatScore, 'number');
  assert.ok(Number.isFinite(quoted.heatScore!), 'a real score is never NaN');
});

test('the greeks are absent rather than zero when the plan omits them', () => {
  const [event] = quotesToFlow([row({ iv: null, delta: null })]);
  assert.equal(event.iv, undefined, 'an IV of 0 is not "no IV"');
  assert.equal(event.delta, undefined, 'a delta of 0 means the opposite of unknown');
});

test('no chain connector substitutes a zero for a field the vendor omitted', () => {
  // Scoped to the fields where a zero is a *reading* — a price, a size, a
  // greek. A zero default on an array length or a loop bound is not this
  // defect, and banning the bare `?? 0` string across four whole files would
  // fail the next person writing one for an honest reason.
  const READINGS =
    'bid|ask|last|lastPrice|price|strike|strikePrice|volume|totalVolume|dayVolume|day-volume' +
    '|openInterest|open-interest|oi|iv|impliedVolatility|volatility|delta|gamma|theta|vega' +
    '|change|changePct|marketCap|dayHigh|dayLow|regularMarket\\w*|fiftyTwoWeek\\w*|underlyingPrice';
  const zeroFill = new RegExp(`(${READINGS})['\\]]?\\s*(\\?\\?|\\|\\|)\\s*0\\b`, 'i');

  const offenders: string[] = [];
  for (const f of CHAIN_CONNECTORS) {
    const src = stripComments(readFileSync(join(CONNECTORS, f), 'utf8'));
    const hit = src.match(zeroFill);
    if (hit) offenders.push(`${f}: ${hit[0].trim()}`);
  }
  assert.deepEqual(offenders, [],
    'a reading defaulted to 0 is indistinguishable from a real zero, and these ' +
    `fields become an NBBO: ${offenders.join(', ')}`);
});

test('the zero-fill guard covers every connector that publishes an NBBO', () => {
  // The rule was written against a hand-listed pair and so did not travel.
  // This asserts the list is the real one: any connector reaching
  // `onFlowEvent` with a bid/ask is a connector whose quote becomes an NBBO.
  const { readdirSync } = require('node:fs') as typeof import('node:fs');
  const publishesQuotes = readdirSync(CONNECTORS)
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => {
      const src = stripComments(readFileSync(join(CONNECTORS, f), 'utf8'));
      return /onFlowEvent\?\.\(|onFlowEvent\(/.test(src) && /\bbid\b/.test(src);
    });
  assert.deepEqual(
    publishesQuotes.sort(),
    [...CHAIN_CONNECTORS].sort(),
    'a connector publishing quotes is missing from CHAIN_CONNECTORS',
  );
});
