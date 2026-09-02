/**
 * Polygon's NBBO path.
 *
 * The trades endpoint carries no quote, so every Polygon signal was
 * non-directional — real prints in, `AMBIGUOUS` out, with the -15 score
 * penalty that carries. The fix is not "attach a quote"; it is "attach the
 * quote that was in force when the trade printed, stamped with its own time,
 * and let the engine decide whether that is close enough".
 *
 * The distinction is the whole thing. Fetching the *current* quote would be
 * useless and unsafe at once: useless because `nbboMaxAgeMs` is 2s and the
 * poll cycle is 10s, so every side would come out AMBIGUOUS anyway; unsafe
 * because a quote from after the trade may already reflect it. `timestamp.lte`
 * bounds the query at or before the trade, making the answer historically
 * correct by construction.
 *
 * **No call in this file has ever been made against real Polygon** — there is
 * no API key in this environment. These drive the parsing, budgeting and
 * timestamp handling with stubbed responses, in the style of
 * `deadSources.test.ts`. The live integration is unverified.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NbboBook } from '../src/flow-engine/nbbo';

const INDEX_SRC = readFileSync(
  join(__dirname, '..', 'src', 'ingestion', 'index.ts'), 'utf8',
);

// ─── The contract ticker ────────────────────────────────────────────────────

test('the option ticker matches Polygon\'s format', () => {
  const { polygonOptionTicker } = loadHelpers();
  // O: + underlying + YYMMDD + C/P + strike * 1000, zero-padded to 8.
  assert.equal(polygonOptionTicker('SPY', '2026-09-18', 'C', 500), 'O:SPY260918C00500000');
  assert.equal(polygonOptionTicker('nvda', '2026-01-16', 'P', 12.5), 'O:NVDA260116P00012500');
  // A strike with an odd fraction must not lose precision to float error.
  assert.equal(polygonOptionTicker('SPX', '2026-12-31', 'C', 5987.5), 'O:SPX261231C05987500');
});

// ─── Staleness is the engine's call, on the real age ────────────────────────

test('a quote five seconds before the trade still yields no side', () => {
  // The discriminating check. `nbboMaxAgeMs` is 2_000, so an as-of-trade quote
  // from 5s earlier is genuinely too old to name a side — and it must come out
  // AMBIGUOUS. If this ever reads BUY, either the quote was published under the
  // trade's timestamp (manufacturing freshness) or the age rule was widened to
  // flatter the feed.
  const book = new NbboBook();
  const sym = 'SPY260918C00500000';
  const tradeTs = 1_780_000_000_000;

  book.onQuote({ ts: tradeTs - 5_000, contractSymbol: sym, bid: 1.0, ask: 1.1 });
  assert.equal(book.inferSide(sym, 1.1, tradeTs, 2_000), 'AMBIGUOUS');
});

test('a quote inside the window does give a side', () => {
  // The other half: the feature has to actually work when the quote is fresh,
  // or this is just an elaborate way of changing nothing.
  const book = new NbboBook();
  const sym = 'SPY260918C00500000';
  const tradeTs = 1_780_000_000_000;

  book.onQuote({ ts: tradeTs - 500, contractSymbol: sym, bid: 1.0, ask: 1.1 });
  assert.equal(book.inferSide(sym, 1.1, tradeTs, 2_000), 'BUY');
  assert.equal(book.inferSide(sym, 1.0, tradeTs, 2_000), 'SELL');
});

// ─── Parsing ────────────────────────────────────────────────────────────────

test('a quote is converted from nanoseconds and kept whole', () => {
  const { fetchPolygonNbbo } = loadHelpers({
    results: [{ bid_price: 1.02, ask_price: 1.08, sip_timestamp: 1_780_000_000_123_000_000 }],
  });
  return fetchPolygonNbbo('O:SPY260918C00500000', 1_780_000_000_500_000_000).then((q: any) => {
    assert.equal(q.bid, 1.02);
    assert.equal(q.ask, 1.08);
    assert.equal(q.ts, 1_780_000_000_123, 'nanoseconds → epoch ms');
  });
});

test('an empty result is a missing quote, not a failure', () => {
  const { fetchPolygonNbbo } = loadHelpers({ results: [] });
  return fetchPolygonNbbo('O:X', 1).then((q: any) => assert.equal(q, undefined));
});

test('a zero or crossed book is refused', () => {
  // These would overwrite a good prior quote in the engine's book.
  const cases = [
    { bid_price: 1.0, ask_price: 0, sip_timestamp: 1e18 },
    { bid_price: 1.5, ask_price: 1.0, sip_timestamp: 1e18 },
    { bid_price: -1, ask_price: 1.0, sip_timestamp: 1e18 },
    { bid_price: 'x', ask_price: 1.0, sip_timestamp: 1e18 },
  ];
  return Promise.all(cases.map(async (c) => {
    const { fetchPolygonNbbo } = loadHelpers({ results: [c] });
    const q = await fetchPolygonNbbo('O:X', 2e18);
    assert.equal(q, undefined, `${JSON.stringify(c)} should be refused`);
  })).then(() => undefined);
});

// ─── The query, the budget, the reporting ───────────────────────────────────

test('the query is bounded at or before the trade', () => {
  // Without `timestamp.lte` this fetches the current quote, which is both
  // useless against a 2s window and look-ahead against an older print.
  assert.match(INDEX_SRC, /'timestamp\.lte':\s*String\(tradeTsNs\)/);
  assert.match(INDEX_SRC, /order:\s*'desc'/);
  assert.match(INDEX_SRC, /limit:\s*1\b/);
});

test('lookups are capped and deduped per cycle', () => {
  // 25 trades per poll against a vendor whose free tier allows 5 calls/min.
  assert.match(INDEX_SRC, /const POLYGON_QUOTE_BUDGET = \d+;/);
  assert.match(INDEX_SRC, /if \(spent >= POLYGON_QUOTE_BUDGET\) break;/);
  assert.match(INDEX_SRC, /if \(quotes\.has\(ticker\)\) continue;/);
});

test('the key stays in the header, never the query string', () => {
  // /api/health publishes vendor error bodies, and those can echo the URL.
  const quoteCall = INDEX_SRC.slice(INDEX_SRC.indexOf('async function fetchPolygonNbbo'));
  assert.match(quoteCall.slice(0, 900), /Authorization: `Bearer \$\{POLYGON_KEY\}`/);
  assert.ok(!/apiKey=|apikey=\$\{POLYGON_KEY\}/.test(quoteCall.slice(0, 900)));
});

test('a quote failure does not report the trades feed as down', () => {
  // Polygon plans commonly include trades and not quotes. Flipping the source
  // to `error` would say the feed is dead while it is delivering prints.
  assert.match(INDEX_SRC, /polygonQuoteNote = quoteFailure/);
  assert.match(INDEX_SRC, /stays AMBIGUOUS/);
  const inner = INDEX_SRC.slice(
    INDEX_SRC.indexOf('const nbbo = await fetchPolygonNbbo'),
    INDEX_SRC.indexOf('polygonQuoteNote = quoteFailure'),
  );
  assert.ok(
    !/sources\['polygon'\] = 'error'/.test(inner),
    'the quote catch must not mark the whole source as failed',
  );
});

test('the degraded state is reported, not just the binary one', () => {
  assert.match(INDEX_SRC, /sourceNotes: notes/);
});

test('the quote is published under its own timestamp', () => {
  // Stamping a 5s-old quote with the trade's ts would manufacture freshness and
  // hand the staleness rule a fabricated age to judge.
  const adapter = readFileSync(
    join(__dirname, '..', 'src', 'ingestion', 'flowEngineAdapter.ts'), 'utf8',
  );
  assert.match(adapter, /engine\.onQuote\(\{\s*ts:\s*print\.quoteTs \?\? ts,/);
  assert.match(INDEX_SRC, /quoteTs:\s*nbbo\?\.ts,/);
});

// ─── Loading with a stubbed transport ───────────────────────────────────────

function loadHelpers(quoteBody: any = { results: [] }) {
  const stub = { get: async () => ({ data: quoteBody }) };
  const path = require.resolve('../src/ingestion/index');
  const axiosPath = require.resolve('axios');
  const realAxios = require.cache[axiosPath];

  delete require.cache[path];
  require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true,
    exports: { default: stub, ...stub } } as any;
  try {
    return require(path) as any;
  } finally {
    if (realAxios) require.cache[axiosPath] = realAxios;
    else delete require.cache[axiosPath];
    delete require.cache[path];
  }
}
