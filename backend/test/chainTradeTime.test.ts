/**
 * A chain snapshot cannot say which side traded, and used to say it anyway.
 *
 * `marketData`, `yahoo`, `tastytrade` and `schwab` poll option *chains*. Each
 * row they turn into a print is three things that did not happen together:
 *
 *     price  = `last`      a trade at some unknown moment in the session
 *     size   = day volume  the whole session's cumulative contracts
 *     bid/ask              the NBBO as of the poll
 *
 * All four stamp the event `new Date().toISOString()` — the moment this
 * process read the chain — and `legacyEventToPrint` puts that in `ts`.
 * `quoteTs` defaulted to `ts`, so the trade and the quote were asserted
 * simultaneous, which is the one thing known to be false about them.
 *
 * `inferSide` refuses to answer when the quote is more than `maxAgeMs` from
 * the trade — the rule `nbbo.ts` opens by calling the #1 way flow tools lie.
 * A gap asserted as zero can never exceed 2s, so that rule could not fire for
 * any of these sources: a day's aggregate volume compared against a closing
 * quote came out BUY, BULLISH, with no penalty.
 *
 * ── What does not fix it ────────────────────────────────────────────────────
 *
 * CLAUDE.md recorded this finding with a named blocker: "closing it needs an
 * as-of/delay concept that `provenance/rights.ts` does not carry yet." That is
 * wrong, and the test below is what shows it. The rule measures the *gap*
 * between quote and trade, so stamping the snapshot with its true as-of time
 * moves both stamps and preserves the gap at zero. A 24-hour-old snapshot
 * still infers BUY. A delay concept buys honest labelling and leaves the
 * inference exactly as wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ingestPrint, drainIdle, resetDaily, type RawPrint } from '../src/ingestion/flowEngineAdapter';

const T0 = Date.UTC(2026, 5, 1, 14, 30, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

/** A chain-derived print, as `legacyEventToPrint` builds one. */
function chainPrint(over: Partial<RawPrint> = {}): RawPrint {
  return {
    ts: T0,
    symbol: 'CHAIN',
    expiry: '2026-12-18',
    strike: 550,
    right: 'C',
    price: 5,          // `last` — traded at an unknown moment
    size: 400,         // the day's cumulative volume
    exchange: 'CHAIN',
    bid: 4.9,
    ask: 5.0,          // fill at the ask: BUY, if the two were simultaneous
    openInterest: 100,
    underlyingPrice: 580,
    source: 'marketdata',
    synthetic: true,
    tradeTimeUnknown: true,
    ...over,
  };
}

function ingestAndDrain(p: RawPrint) {
  resetDaily();
  return [...ingestPrint(p), ...drainIdle(0)];
}

test('a chain print does not report a side it cannot know', () => {
  const [sig] = ingestAndDrain(chainPrint({ symbol: 'CHAIN_A' }));
  assert.ok(sig, 'the print is still a signal — it is the side that is unknown');
  assert.equal(sig.side, 'AMBIGUOUS');
  assert.equal(sig.sentiment, 'NEUTRAL',
    'BULLISH here was a direction read off a comparison that could not be made');
  assert.equal(sig.score_breakdown.ambiguousPenalty, -15,
    'and it scores as the unknown it is, through the path already defined for a missing quote');
});

test('a source that does know keeps its inference', () => {
  // The guard is about the *claim*, not about chains. A tape print carrying
  // its own quote — Tradier, or Polygon with a real `quoteTs` — is unaffected.
  const [sig] = ingestAndDrain(chainPrint({
    symbol: 'CHAIN_B', source: 'tradier', synthetic: false, tradeTimeUnknown: undefined,
  }));
  assert.equal(sig.side, 'BUY', 'a fill at the ask, against a quote known to be simultaneous');
  assert.equal(sig.sentiment, 'BULLISH');
});

test('stamping the snapshot with its true as-of time changes nothing', () => {
  // The recorded blocker was an as-of/delay concept. This is why that would
  // not have closed it: the rule measures the gap, and shifting both stamps
  // back by the vendor's delay preserves the gap at zero.
  for (const [label, delay] of [['15 minutes', 15 * MIN], ['24 hours', 24 * HOUR]] as const) {
    const [sig] = ingestAndDrain(chainPrint({
      symbol: `ASOF_${delay}`,
      ts: T0 - delay,
      quoteTs: T0 - delay,
      tradeTimeUnknown: undefined,   // as an as-of fix alone would have left it
    }));
    assert.equal(sig.side, 'BUY',
      `a snapshot ${label} old still infers a side when only the stamps move`);
  }
});

test('a real gap between quote and trade is what the rule was built to catch', () => {
  // And it does catch it, which is why the fix is to stop asserting a zero gap
  // rather than to change the rule.
  const [sig] = ingestAndDrain(chainPrint({
    symbol: 'GAP', ts: T0, quoteTs: T0 - 15 * MIN, tradeTimeUnknown: undefined,
  }));
  assert.equal(sig.side, 'AMBIGUOUS');
});

test('the withheld quote does not leak into a later print on the same contract', () => {
  // `ingestPrint` withholds the NBBO entirely rather than stamping it. The
  // cost is that the book never learns this contract's bid/ask — deliberate,
  // because a delayed chain's quote is not evidence about a live fill either,
  // and with the gap asserted as zero the staleness rule could not have caught
  // that case any better than this one.
  resetDaily();
  ingestPrint(chainPrint({ symbol: 'LEAK', id: 'chain-1' }));
  const [sig] = [...ingestPrint(chainPrint({
    symbol: 'LEAK', id: 'live-1', ts: T0 + 1000,
    bid: undefined, ask: undefined,        // the live print carries no quote
    tradeTimeUnknown: undefined, synthetic: false, source: 'tradier',
  })), ...drainIdle(0)];
  assert.equal(sig.side, 'AMBIGUOUS',
    'the chain NBBO must not have been left in the book for a live print to use');
});

test('all four chain connectors reach the engine through the one seam', () => {
  // The statement is made once, in `legacyEventToPrint`. That is only correct
  // while every chain connector still goes through it — a fifth wired
  // straight to `ingestPrint` would be back to asserting a zero gap, and
  // nothing else in this file would notice.
  const src = readFileSync(join(__dirname, '..', 'src', 'ingestion', 'index.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');

  assert.match(src, /tradeTimeUnknown:\s*true/,
    'legacyEventToPrint must declare the gap unknown');

  for (const feed of ['onMarketDataFlow', 'onSchwabFlow', 'onTastytradeFlow', 'onYahooFlow']) {
    assert.match(src, new RegExp(`${feed}\\(feedLegacy\\(`),
      `${feed} must go through feedLegacy, which is what applies the rule`);
  }

  // And none of the four may stamp a print itself.
  const CONNECTORS = join(__dirname, '..', 'src', 'ingestion', 'connectors');
  for (const f of ['marketData.ts', 'yahoo.ts', 'tastytrade.ts', 'schwab.ts']) {
    const c = readFileSync(join(CONNECTORS, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    assert.ok(!/quoteTs/.test(c),
      `${f} sets quoteTs directly — it has no trade time to relate a quote to`);
  }
});
