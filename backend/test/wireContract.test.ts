/**
 * The frontend's types, checked against responses the backend actually gave.
 *
 * Every UI bug fixed in this repo lately has been the same one: a page reading
 * a field the API does not send, failing silently. `VIXData.timestamp` against
 * a route sending `updatedAt`, so the panel rendered "Invalid Date" whenever
 * the data was real. `Array.isArray(q)` against a `{ quotes: [...] }` body, so
 * CoinGecko's live quotes were dropped. `StooqQuote.price` against a wire
 * carrying a daily OHLC bar, which would have thrown the moment data arrived.
 * `DarkPoolPrint.created_at` against a wire sending `timestamp`.
 *
 * None of those are catchable by typechecking, because the frontend's
 * interfaces are assertions about a separate process. They are catchable
 * against a recorded response, which is what `tools/preview/capture.ts`
 * produces — so the fixtures here are real payloads, not hand-written ones
 * that would drift the same way the interfaces did.
 *
 * Re-record with:
 *   DEMO_MODE=1 npm run dev              # in another shell
 *   npm run preview:capture -- --out test/fixtures
 *
 * These are text assertions against source, which is what a backend suite can
 * reach across the directory boundary. `frontend/test/` now renders the same
 * components against these same fixtures and asserts what a person sees — the
 * half text matching cannot do. Both are worth having: this file catches a
 * field name drifting, that one catches a field name being read correctly and
 * displayed wrongly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const FIX = join(__dirname, 'fixtures');
const TYPES = join(__dirname, '..', '..', 'frontend', 'lib', 'types.ts');

const load = (n: string) => JSON.parse(readFileSync(join(FIX, `${n}.json`), 'utf8'));

/**
 * Source with comments removed, line comments first.
 *
 * These checks ask whether a dead field name is *absent*, so a comment
 * explaining which field used to be read there would fail them — and the
 * explanation is worth more than the convenience of a naive scan. Line
 * comments go first: a `//` mentioning a path like `/api/*` contains `/*`, and
 * block-first would open a phantom comment that swallows real code, which
 * fails open.
 */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Field names declared on a `interface X { ... }` block in the frontend types. */
function fieldsOf(iface: string): Set<string> {
  const src = readFileSync(TYPES, 'utf8');
  const start = src.indexOf(`export interface ${iface} {`);
  assert.ok(start >= 0, `frontend/lib/types.ts should declare ${iface}`);
  const body = src.slice(start, src.indexOf('\n}', start));
  return new Set(
    [...body.matchAll(/^\s{2}(?:\/\*\*[\s\S]*?\*\/\s*)?([a-zA-Z_][a-zA-Z0-9_]*)\??:/gm)]
      .map((m) => m[1]!),
  );
}

/** Every field the page could read must exist on the recorded response. */
function assertDeclaredFieldsExist(iface: string, sample: Record<string, unknown>) {
  const declared = fieldsOf(iface);
  const actual = new Set(Object.keys(sample));
  const phantom = [...declared].filter((f) => !actual.has(f)).sort();
  assert.deepEqual(
    phantom, [],
    `${iface} declares fields the backend does not send: ${phantom.join(', ')}\n` +
    `  backend sent: ${[...actual].sort().join(', ')}`,
  );
}

test('the fixtures are real recorded responses, not stubs', () => {
  // A hand-written fixture would drift exactly as the interfaces did, and this
  // suite would then be checking one fiction against another.
  for (const n of ['gex', 'darkpool', 'flow', 'vix', 'health']) {
    assert.ok(existsSync(join(FIX, `${n}.json`)), `${n}.json missing — re-record with preview:capture`);
  }
  const flow = load('flow');
  assert.ok(Array.isArray(flow.data) && flow.data.length > 0, 'flow fixture should carry signals');
});

// ─── GEX ────────────────────────────────────────────────────────────────────

test('GEXLevel matches what /api/gex returns', () => {
  // The chart used to declare net_gex/call_gex/put_gex/level_type. The backend
  // sends none of them — and never labelled a strike SUPPORT or RESISTANCE at
  // all; the chart decided that with `Math.random() > 0.5`.
  const level = load('gex').levels[0];
  assertDeclaredFieldsExist('GEXLevel', level);
  for (const f of ['strike', 'gex', 'callOI', 'putOI', 'callGamma', 'putGamma']) {
    assert.ok(f in level, `/api/gex levels should carry ${f}`);
  }
  assert.ok(!('level_type' in level), 'the backend does not classify strikes — the UI must not imply it does');
});

test('GEXResponse carries the provenance the chart must not ignore', () => {
  const gex = load('gex');
  assertDeclaredFieldsExist('GEXResponse', gex);
  // The route's own comment: "a fabricated gamma flip looks exactly like a real one."
  assert.equal(typeof gex.realData, 'boolean');
  assert.ok(['cboe', 'synthetic'].includes(gex.source));
  assert.ok('delayedMinutes' in gex && 'flipStrike' in gex);
});

test('the GEX chart reads only fields the backend sends', () => {
  const chart = code(join(__dirname, '..', '..', 'frontend', 'components', 'gex', 'GEXChart.tsx'));
  for (const dead of ['net_gex', 'call_gex', 'put_gex', 'level_type']) {
    assert.ok(!chart.includes(dead), `GEXChart still reads ${dead}, which /api/gex does not send`);
  }
  assert.ok(!/Math\.random/.test(chart), 'the chart must not invent gamma exposure');
  assert.ok(chart.includes('realData'), 'the chart must honour realData');
});

// ─── Dark pool ──────────────────────────────────────────────────────────────

test('DarkPoolPrint matches what /api/darkpool returns', () => {
  const print = load('darkpool').data[0];
  assertDeclaredFieldsExist('DarkPoolPrint', print);
  assert.ok('timestamp' in print, 'the wire sends timestamp, not created_at');
  assert.ok('source' in print, 'source is how a simulated print is identifiable');
});

test('the dark pool page renders the backend\'s own notice, not an invented badge', () => {
  const body = load('darkpool');
  assert.ok(body.notice?.length > 20 && body.disclaimer?.length > 20);

  const page = code(join(__dirname, '..', '..', 'frontend', 'app', 'dark-pool', 'page.tsx'));
  assert.ok(page.includes('meta?.notice') || page.includes('meta.notice'),
    'the page must render the notice the backend sends');
  assert.ok(page.includes('disclaimer'), 'and the disclaimer');
  assert.ok(!/24-HOUR DELAY/.test(page),
    'the hardcoded delay badge asserted a regulatory fact over invented prints');
  assert.ok(!/Math\.random/.test(page), 'the page must not generate prints');
});

// ─── Flow ───────────────────────────────────────────────────────────────────

test('the synthetic flag the backend sets is surfaced per row', () => {
  const rows = load('flow').data as Array<Record<string, unknown>>;
  // In a keyless run every signal is synthetic; in a credentialed one only the
  // chain-snapshot connectors are. Both need the marker, and only a per-row one
  // works for the second case.
  assert.ok(rows.some((r) => r.synthetic === true), 'fixture should contain synthetic signals');

  const feed = code(join(__dirname, '..', '..', 'frontend', 'components', 'flow', 'FlowFeed.tsx'));
  assert.ok(/e\.synthetic/.test(feed), 'FlowFeed must render the synthetic marker');
});

test('AMBIGUOUS side never carries a direction', () => {
  // The engine's contract, checked against real output rather than trusted:
  // a signal whose side could not be inferred must not present as directional.
  const rows = load('flow').data as Array<Record<string, unknown>>;
  const ambiguous = rows.filter((r) => r.side === 'AMBIGUOUS');
  assert.ok(ambiguous.length > 0, 'fixture should contain AMBIGUOUS signals');
  for (const r of ambiguous) {
    assert.equal(r.sentiment, 'NEUTRAL',
      `an AMBIGUOUS signal presented as ${r.sentiment}`);
  }
});

// ─── Health ─────────────────────────────────────────────────────────────────

test('the settings page reads fields /api/health actually sends', () => {
  const h = load('health');
  assert.ok(h.ingestion?.sources && h.ingestion?.sourceErrors, 'health must carry connector state');
  assert.ok(Array.isArray(h.ingestion.rightsRefusals), 'and rights refusals');
  // `enrichment.state`, not `.status` — the settings page had this wrong, and
  // only a real payload caught it.
  assert.ok('state' in (h.enrichment ?? {}), 'enrichment reports `state`');
  const page = code(join(__dirname, '..', '..', 'frontend', 'app', 'settings', 'page.tsx'));
  assert.ok(!/enrichment\.status/.test(page), 'the page must not read enrichment.status');
});


// ─── Nothing is manufactured in the browser ─────────────────────────────────

/**
 * The terminal must not invent its own tape.
 *
 * `useFlowFeed` seeded the store with 50 events from `generateSeedFlow` on
 * mount — random tickers, premiums to $15M, heat drawn uniformly from 40 to
 * 100 — and produced one more every eight seconds while the socket was down.
 * The seeded fifty went in through `addFlowBatch` and only misinformed the
 * reader; the eight-second ones went through `handleEvent`, which raises a
 * power alert at heat 75, **speaks the trade aloud** above 80, and fires an
 * **OS push notification** above 85. A terminal with no market data connection
 * was announcing sweeps that had not happened.
 *
 * The backend already simulates prints when no keys are configured and flags
 * them `synthetic` on the wire, so the client-side generator was redundant
 * even in an honest form — and flagging it would not have helped, because
 * neither `speakAlert` nor `pushNotification` looks at that field.
 */
const FRONTEND = join(__dirname, '..', '..', 'frontend');

test('the flow feed generates nothing locally', () => {
  const hook = code(join(FRONTEND, 'hooks', 'useFlowFeed.ts'));
  assert.ok(!/Math\.random/.test(hook), 'useFlowFeed must not manufacture events');
  assert.ok(!/generateSeedFlow/.test(hook), 'the seed generator must not be called');
  assert.ok(!/setInterval/.test(hook), 'no timer should be producing flow');
});

test('generateSeedFlow is gone, not merely unused', () => {
  // Left in place it would be one import away from returning, and the next
  // caller would not know what it feeds.
  const utils = code(join(FRONTEND, 'lib', 'utils.ts'));
  assert.ok(!/export function generateSeedFlow/.test(utils),
    'the generator must be deleted from lib/utils.ts');
});

test('speech and notifications are still wired for real signals', () => {
  // The fix is what was being fed to them, not the alerting itself. Removing
  // these would be a different and unasked-for change.
  const hook = code(join(FRONTEND, 'hooks', 'useFlowFeed.ts'));
  assert.ok(/speakAlert\(event\)/.test(hook), 'real signals should still be speakable');
  assert.ok(/pushNotification\(event\)/.test(hook), 'and still notifiable');
});

test('pages built from the store handle an empty store', () => {
  // Every one of these was unreachable while the seed guaranteed 50 events.
  for (const [file, marker] of [
    [join(FRONTEND, 'components', 'flow', 'FlowFeed.tsx'), /sorted\.length === 0/],
    [join(FRONTEND, 'app', 'heat-map', 'page.tsx'), /heatData\.length === 0/],
    [join(FRONTEND, 'app', 'power-alerts', 'page.tsx'), /powerAlerts\.length === 0/],
  ] as Array<[string, RegExp]>) {
    assert.match(code(file), marker, `${file} needs an empty state`);
  }
});


// ─── No unprovenanced confidence ────────────────────────────────────────────

/**
 * The ML service and its `ml_score` slot.
 *
 * `ml-service/` was a FastAPI app deployed as its own Render service, exposing
 * `/score` for "unusual flow scoring", and nothing in `backend/src` ever called
 * it. Its model could not have been trusted if it had: `train.py` draws the
 * label first — `is_unusual = rng.random() < 0.25` — and then samples the
 * features from two hand-written distributions conditioned on that label, so a
 * classifier fit to it can only recover the author's own branch. Trained on
 * `np.random` with seed 42, it encoded the generator, not the market.
 *
 * The dangerous part was not the service; it was the socket left for it.
 * `PowerAlert.ml_score` was on the wire and `power-alerts/page.tsx` rendered
 * `ML CONFIDENCE: {(alert.ml_score * 100).toFixed(0)}%`, gated behind `> 0`.
 * Nothing populated it, so it never showed — and the next person to assign
 * anything to that field would have shipped a confidence percentage with no
 * provenance, in green, next to a real signal.
 *
 * Scoring already happens in `flow-engine/score.ts`: deterministic, documented,
 * and carrying per-component `score_breakdown` on the wire, which is a strictly
 * better thing to show than an opaque number.
 */
test('nothing presents a model confidence', () => {
  for (const f of [
    join(FRONTEND, 'app', 'power-alerts', 'page.tsx'),
    join(FRONTEND, 'lib', 'types.ts'),
    join(FRONTEND, 'hooks', 'useFlowFeed.ts'),
    join(__dirname, '..', 'src', 'ingestion', 'flowEngineAdapter.ts'),
  ]) {
    assert.ok(!/ml_score/.test(code(f)), `${f} still carries an ml_score slot`);
  }
});

test('the ML service is gone from the tree and the Blueprint', () => {
  assert.ok(
    !existsSync(join(__dirname, '..', '..', 'ml-service')),
    'ml-service/ should be deleted, not left unreferenced',
  );
  const blueprint = readFileSync(join(__dirname, '..', '..', 'render.yaml'), 'utf8')
    .replace(/^\s*#.*$/gm, '');
  assert.ok(!/quantflow-pro-ml/.test(blueprint), 'the Blueprint should not declare it');
  assert.ok(!/uvicorn/.test(blueprint), 'nor start it');
});

test('scoring still exists, and is the auditable kind', () => {
  // Deleting a scorer would be capability loss if there were not already a
  // better one. `scoreSignal` is deterministic and attributes its own output.
  const engine = readFileSync(join(__dirname, '..', 'src', 'flow-engine', 'score.ts'), 'utf8');
  assert.match(engine, /export function scoreSignal/);
  const rows = load('flow').data as Array<Record<string, unknown>>;
  assert.ok(
    rows.every((r) => r.score_breakdown && typeof r.score_breakdown === 'object'),
    'every recorded signal should carry its per-component attribution',
  );
});


// ─── The ticker tape ────────────────────────────────────────────────────────

/**
 * The tape in `TopBar`, mounted in `app/layout.tsx` and therefore on screen
 * above every page in the terminal.
 *
 * It rendered a hardcoded base map — SPX 5587, NVDA 942, TSLA 182, prices from
 * 2024 — plus `Math.random() * 4 - 1.5` per symbol, re-rolled on a
 * `Math.random() > 0.7` coin flip every ten seconds, in the same monospace and
 * the same green and red as the live panels beneath it. The last and most
 * visible member of the family that already cost the seeded flow feed, the
 * generated dark-pool prints and the coin-flipped support/resistance levels.
 *
 * There is no `quotes.json` fixture to check the interface against, and adding
 * one would be ceremony: with no `TWELVE_DATA_API_KEY` the capture is
 * `{"quotes": []}`, which carries no field names and so cannot do the one job
 * the fixtures exist for. The route does no reshaping —
 * `Array.from(getSpotQuotes().values())` — so the connector's own `SpotQuote`
 * *is* the wire, and that is what the frontend's copy is checked against here.
 */

const TWELVEDATA = join(__dirname, '..', 'src', 'ingestion', 'connectors', 'twelveData.ts');

/** Field names declared on an `interface X { ... }` block in any file. */
function fieldsOfIn(path: string, iface: string): Set<string> {
  const src = readFileSync(path, 'utf8');
  const start = src.indexOf(`export interface ${iface} {`);
  assert.ok(start >= 0, `${path} should declare ${iface}`);
  const body = src.slice(start, src.indexOf('\n}', start));
  return new Set(
    [...body.matchAll(/^\s{2}(?:\/\*\*[\s\S]*?\*\/\s*)?([a-zA-Z_][a-zA-Z0-9_]*)\??:/gm)]
      .map((m) => m[1]!),
  );
}

test('the frontend SpotQuote matches the connector the route serves', () => {
  const wire = fieldsOfIn(TWELVEDATA, 'SpotQuote');
  const declared = fieldsOf('SpotQuote');
  const phantom = [...declared].filter((f) => !wire.has(f)).sort();
  assert.deepEqual(
    phantom, [],
    `frontend SpotQuote declares fields the connector does not send: ${phantom.join(', ')}\n` +
    `  connector sends: ${[...wire].sort().join(', ')}`,
  );
  // `symbol`, not `ticker` — the field `MarketSnapshot` got wrong.
  assert.ok(wire.has('symbol') && declared.has('symbol'));
  assert.ok(declared.has('timestamp'), 'the tape needs the clock to date a stale price');
});

test('MarketSnapshot is gone, not merely unused', () => {
  // It declared `ticker`, `price`, `change`, `changePct` against an endpoint
  // that has never sent `ticker`, and nothing imported it. Left in place it is
  // one import away from a page rendering `undefined` down a column — the
  // hazard `ml_score` was removed for.
  assert.ok(
    !/interface MarketSnapshot/.test(readFileSync(join(FRONTEND, 'lib', 'types.ts'), 'utf8')),
    'MarketSnapshot should be replaced by the wire type, not left beside it',
  );
});

test('the ticker tape reads the API and invents nothing', () => {
  const bar = code(join(FRONTEND, 'components', 'layout', 'TopBar.tsx'));
  assert.ok(!/Math\.random/.test(bar), 'the tape must not generate prices');
  assert.ok(!/generateQuotes/.test(bar), 'the generator must be deleted, not merely uncalled');
  assert.ok(
    !/\b(SPX|NVDA|TSLA|MSTR)\b\s*:\s*\d/.test(bar),
    'the hardcoded 2024 base price map must not come back',
  );
  assert.ok(/\/api\/macro\/quotes/.test(bar), 'the tape must read the spot-quote route');
  assert.ok(/apiFetch/.test(bar), 'and go through the module that attaches the token');
});

test('the tape has a state for having no quotes', () => {
  // A tape that renders an empty strip when the feed is down looks identical
  // to a tape that is still loading, and both look like a working tape with
  // nothing to say. `/api/macro/quotes` returns `{quotes: []}` on every
  // keyless deployment, which is most of them.
  const bar = readFileSync(join(FRONTEND, 'components', 'layout', 'TopBar.tsx'), 'utf8');
  assert.match(bar, /quotes\.length === 0/, 'the empty feed needs a rendered state');
  assert.match(bar, /NO SPOT FEED REPORTING/, 'and it must say so in words');
  assert.match(bar, /UNREACHABLE/, 'an outage is a different answer from an empty feed');
});

test('the tape dates a price it can no longer vouch for', () => {
  // The connector caches, so a dead feed keeps serving its last quotes
  // forever. Rendering those in the live styling is the Stooq failure with a
  // different connector — see `deadSources.test.ts`.
  const bar = readFileSync(join(FRONTEND, 'components', 'layout', 'TopBar.tsx'), 'utf8');
  assert.match(bar, /STALE_MS/, 'the tape needs a staleness threshold');
  assert.match(bar, /AS OF/, 'and must say when stale prices are from');
});

// ─── The news page ──────────────────────────────────────────────────────────

/**
 * Three panels, three hardcoded arrays.
 *
 * Two of them were unreachable-by-construction: the page tested
 * `Array.isArray(body)` against `{ headlines: [...] }` and
 * `{ earnings: [...] }`, so the live arrays never populated on any deployment
 * and the fallback always won. The content is what raises this above the rest
 * of the family — six invented headlines attributed by name to Reuters,
 * Bloomberg, CNBC, MarketWatch, the WSJ and Barron's, and six invented Reddit
 * posts in quotation marks. The others fabricated numbers; this one fabricated
 * reporting and put real newsrooms' names on it.
 *
 * The render-level assertions are in `frontend/test/newsPage.test.tsx`. These
 * are the source-level ones: that the arrays are gone rather than unused, and
 * that the page reads the envelopes the routes actually send.
 */

const NEWS_PAGE = join(FRONTEND, 'app', 'news', 'page.tsx');

test('the invented headlines are gone, not merely unrendered', () => {
  const page = readFileSync(NEWS_PAGE, 'utf8');
  assert.ok(!/const FALLBACK/.test(page), 'a FALLBACK array survives on the news page');
  for (const outlet of ['Bloomberg', 'MarketWatch', "Barron", 'CNBC']) {
    // Named outlets may appear in the file's history note; they must not
    // appear in a data literal. The check is that no string is assigned as a
    // publisher, which is what `publisher:` would look like.
    assert.ok(
      !new RegExp(`publisher:\\s*['"\`]${outlet}`).test(page),
      `the page still carries a hardcoded ${outlet} byline`,
    );
  }
});

test('the news page reads the envelope each route sends', () => {
  // `Array.isArray(response)` against `{headlines: [...]}` is always false.
  // The same mistake emptied the macro page, twice.
  const page = readFileSync(NEWS_PAGE, 'utf8');
  for (const key of ['headlines', 'reddit', 'earnings']) {
    assert.match(page, new RegExp(`listAt\\(b, '${key}'\\)`), `the page must read \`${key}\` off the body`);
  }
});

test('every news panel distinguishes refused, empty and unreachable', () => {
  const page = readFileSync(NEWS_PAGE, 'utf8');
  assert.match(page, /REFUSED — the backend did not accept this session/, 'a refused panel is not an empty one');
  // And does not send a reader gated in by `middleware.ts` back to the login
  // page over what is usually a backend misconfiguration.
  assert.ok(!/sign in|SIGNED OUT/i.test(page.replace(/\/\*[\s\S]*?\*\//g, '')),
    'the refusal notice must not prescribe signing in');
  assert.match(page, /UNREACHABLE/, 'an outage is not an empty one either');
  assert.match(page, /see Settings for source status/, 'and an empty one points somewhere');
});

test('the frontend news types match what the sentiment route sends', () => {
  // The old `RedditPost` declared `sentiment`, `bullishPct`, `bearishPct`,
  // `topPost` and `lastUpdated` — five fields, none of which the wire has
  // ever carried. `EarningsEvent` declared `name` and a BMO/AMC `time`, which
  // FMP's calendar does not send either.
  const REDDIT = join(__dirname, '..', 'src', 'ingestion', 'connectors', 'reddit.ts');
  const FMP = join(__dirname, '..', 'src', 'ingestion', 'connectors', 'fmp.ts');

  for (const [iface, path, backendName] of [
    ['RedditSentiment', REDDIT, 'RedditSentiment'],
    ['EarningsEvent', FMP, 'EarningsEvent'],
    ['NewsItem', join(__dirname, '..', 'src', 'routes', 'sentiment.ts'), 'NewsWireItem'],
  ] as const) {
    const wire = fieldsOfIn(path, backendName);
    const phantom = [...fieldsOf(iface)].filter((f) => !wire.has(f)).sort();
    assert.deepEqual(
      phantom, [],
      `frontend ${iface} declares fields the backend does not send: ${phantom.join(', ')}\n` +
      `  backend sends: ${[...wire].sort().join(', ')}`,
    );
  }
});

// ─── The 2024 price map, in the two files it survived in ────────────────────

/**
 * `TopBar` lost its hardcoded base map when the tape stopped inventing its
 * prices. Two copies were left behind, and neither was flagged by anything:
 *
 *   - `app/watchlist/page.tsx` held fifteen 2024 levels in `SPOT_PRICES` and
 *     rendered them under each ticker as the card's price — the tape's map
 *     with the `Math.random()` jitter left off. Five of the fifteen (MU, MRVL,
 *     IWM, GLD, SOXL) are not symbols the spot connector covers at all, so
 *     they could not have been right even in 2024: a hand-maintained list in
 *     front of a feed, which is the defect that retired three lists from the
 *     settings page and seven tickers from the tape.
 *   - `components/calculator/StrategyBuilder.tsx` held eight in `SPOTS` and
 *     priced every Black-Scholes leg off them.
 *
 * The render-level assertions are in `frontend/test/spotSeed.test.tsx`.
 */

const WATCHLIST = join(FRONTEND, 'app', 'watchlist', 'page.tsx');
const BUILDER = join(FRONTEND, 'components', 'calculator', 'StrategyBuilder.tsx');

test('no page carries its own price map', () => {
  for (const path of [WATCHLIST, BUILDER, join(FRONTEND, 'components', 'layout', 'TopBar.tsx')]) {
    const code = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    // The 2024 levels themselves, which is what a revived map would carry.
    for (const level of ['5587', '557', '942', '472', '376', '428']) {
      assert.ok(!new RegExp(`:\\s*${level}\\b`).test(code),
        `${path} still maps a symbol to ${level}`);
    }
    assert.ok(!/SPOT_PRICES|const SPOTS\b/.test(code), `${path} still declares a price map`);
  }
});

test('both pages read the spot feed rather than a constant', () => {
  for (const path of [WATCHLIST, BUILDER]) {
    assert.match(readFileSync(path, 'utf8'), /useSpotQuotes/,
      `${path} should read /api/macro/quotes through the shared feed`);
  }
});

test('the staleness rule has one copy', () => {
  // The tape declared `STALE_MS` locally. Three components now date a quote
  // the feed has stopped refreshing, and "five minutes" living in three files
  // is three places for it to drift.
  const feed = readFileSync(join(FRONTEND, 'lib', 'spotQuotes.ts'), 'utf8');
  assert.match(feed, /export const STALE_MS/, 'the threshold belongs with the feed');
  for (const path of [WATCHLIST, BUILDER, join(FRONTEND, 'components', 'layout', 'TopBar.tsx')]) {
    const code = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    assert.ok(!/const STALE_MS/.test(code), `${path} declares a second staleness threshold`);
  }
});

test('the builder does not price a leg against a spot it does not have', () => {
  // It was `SPOTS[selectedTicker] || 100`: an unknown ticker priced every leg
  // at 100 and said nothing about where 100 came from.
  const code = readFileSync(BUILDER, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  assert.ok(!/\|\| 100/.test(code), 'the fallback spot survives');
  assert.match(code, /useSpot === null/, 'the no-spot case needs a rendered state');
});

// ─── The P/L calculator ─────────────────────────────────────────────────────

/**
 * Selling was a no-op, and a bought call was shown with no downside.
 *
 * `computePLCurve` decided a leg's direction with `leg.qty > 0` while the
 * quantity input clamped to `Math.max(1, …)` with `min={1}` — so the test was
 * true for every leg that could be built and the `ACTION` select changed
 * nothing at all. A sold contract produced a byte-identical curve to a bought
 * one, and with it an identical max profit, max loss and breakeven.
 *
 * `entryPrice` defaulted to `0`, so the curve plotted the position's value
 * rather than its P/L: at the calculator's own defaults a long call reported
 * MAX PROFIT $18,252, MAX LOSS $0, BREAKEVEN — and PREMIUM PAID **Credit**.
 *
 * And the chart was headed P/L AT EXPIRY while plotting `T = dte / 365`, the
 * model value today across spot prices.
 *
 * The arithmetic is tested in `frontend/test/payoff.test.tsx`, which also
 * renders the builder. These are the source-level guards.
 */

test('direction comes from action, and only from action', () => {
  const bs = readFileSync(join(FRONTEND, 'lib', 'blackScholes.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  assert.ok(!/qty > 0/.test(bs),
    'the quantity input clamps to >= 1, so `qty > 0` is true for every leg');
  assert.match(bs, /action === 'BUY'/, 'the curve must read the leg action');

  const payoff = readFileSync(join(FRONTEND, 'lib', 'payoff.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  assert.ok(!/qty > 0/.test(payoff), 'the payoff must not carry a second convention');
});

test('the risk-free rate is passed in, not defaulted', () => {
  // It was `r = 0.05` as a default parameter, plus a second copy inline in the
  // Greeks call — two assumed rates that could disagree, neither on screen.
  const bs = readFileSync(join(FRONTEND, 'lib', 'blackScholes.ts'), 'utf8');
  assert.ok(!/r = 0\.05/.test(bs), 'computePLCurve must not default the rate');
  const builder = readFileSync(BUILDER, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  assert.ok(!/r: 0\.05/.test(builder), 'the Greeks panel must use the same rate as the curve');
  assert.match(builder, /RISK-FREE/, 'and the assumption belongs on screen');
});

test('the chart does not name one curve and draw another', () => {
  const builder = readFileSync(BUILDER, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  assert.ok(!/P\/L AT EXPIRY/.test(builder),
    'that heading sat over `computePLCurve`, which values the position today');
  assert.match(builder, /dataKey="expiry"/, 'the payoff at expiry needs drawing to be claimed');
  assert.match(builder, /dataKey="today"/, 'and the model value is the other series');

  const page = readFileSync(join(FRONTEND, 'app', 'calculator', 'page.tsx'), 'utf8');
  assert.ok(!/P\/L at expiry curve/.test(page), 'the page subtitle repeated the claim');
});

test('the summary tiles report the position, not the plotted range', () => {
  const builder = readFileSync(BUILDER, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  // `Math.min`/`Math.max` over a 60-point sample gave a naked short call a
  // finite max loss, which was a fact about where the range stopped.
  assert.ok(!/Math\.max\(\.\.\.plData/.test(builder) && !/Math\.min\(\.\.\.plData/.test(builder),
    'the extremes must come from the payoff, not from the sample');
  assert.match(builder, /extremes\(legs\)/, 'use the exact extremes');
  assert.match(builder, /breakevens\(legs\)/, 'and the solved breakevens');
  // `total > 0 ? $total : 'Credit'` called a long call at its default entry
  // price a credit. "Nothing entered yet" is a third state.
  assert.ok(!/'Credit'/.test(builder), "the two-state cost label survives");
  assert.match(builder, /no entry set/, 'the unset state needs saying');
});

// ─── The live flow window ───────────────────────────────────────────────────

/**
 * A display filter was deleting the tape.
 *
 * `useFlowFeed.handleEvent` began `if (!passesFilters(event)) return`, so the
 * store held only what matched the filters at the moment each signal arrived —
 * and the filters are a view control. Raising `minPremium` to $1M for a minute
 * and putting it back deleted every sub-$1M print from that minute,
 * permanently, while the control on screen said they were admitted again.
 *
 * The predicate was written out twice, and the second copy re-filtered an
 * already-filtered set. Same class as the ticker tape's `STALE_MS`: one rule,
 * two homes, and the copies could not both be right about when they ran.
 *
 * The behavioural assertions are in `frontend/test/flowWindow.test.tsx`; only
 * a render can show that widening a filter brings signals back.
 */

const FLOW_HOOK = join(FRONTEND, 'hooks', 'useFlowFeed.ts');
const FLOW_FEED = join(FRONTEND, 'components', 'flow', 'FlowFeed.tsx');
const FLOW_STATS = join(FRONTEND, 'components', 'flow', 'FlowStats.tsx');

test('the filter predicate has one definition', () => {
  const predicate = /filters\.optionType !== 'ALL'|f\.optionType !== 'ALL'/;
  const home = readFileSync(join(FRONTEND, 'lib', 'flowFilter.ts'), 'utf8');
  assert.match(home, predicate, 'the predicate belongs in lib/flowFilter.ts');

  for (const path of [FLOW_HOOK, FLOW_FEED]) {
    const code = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    assert.ok(!predicate.test(code), `${path} carries a second copy of the filter`);
  }
});

test('nothing is filtered before it is stored', () => {
  const code = readFileSync(FLOW_HOOK, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  assert.ok(!/passesFilters/.test(code), 'the ingest-time filter survives');
  assert.ok(!/matchesFilters/.test(code),
    'the hook must not consult the filters at all — that is the display layer');
  assert.match(code, /addFlowEvent\(event\)/, 'every signal that arrives is stored');
});

test('an alert is not gated on what is being displayed', () => {
  // A view control with a side effect on speech and desktop notifications.
  const code = readFileSync(FLOW_HOOK, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  assert.match(code, /isPowerAlert\(event\)/, 'the alert criteria live in one named predicate');
});

test('the notification guard cannot throw where the API is absent', () => {
  // `Notification.permission` on a browser without the API is a ReferenceError
  // inside the socket batch handler, which takes the whole feed down.
  const code = readFileSync(FLOW_HOOK, 'utf8');
  assert.match(code, /typeof Notification === 'undefined'/,
    'guard on the API existing, not just on `window`');
});

test('no flow aggregate is labelled a total', () => {
  // `flowEvents` is a 500-event client ring buffer filled from page load. The
  // backend's own buffer caps at 500 too, so reading `/api/flow/stats` would
  // not have made the word true either.
  const stats = readFileSync(FLOW_STATS, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  assert.ok(!/TOTAL/.test(stats), 'a windowed aggregate must not say TOTAL');
  assert.match(stats, /signals received this session/, 'and must say what it is over');
  assert.match(stats, /simulated/, 'an aggregate that pools simulated prints has to count them');
  // `P/C RATIO` named three different quantities across the app.
  assert.ok(!/P\/C RATIO/.test(stats), 'the ratio must name its basis');
});

test('the flow stats endpoint does not share a name with a different quantity', () => {
  const ingestion = readFileSync(join(__dirname, '..', 'src', 'ingestion', 'index.ts'), 'utf8');
  assert.ok(!/^\s*callPutRatio:/m.test(ingestion),
    'callPutRatio was a count ratio sharing a name with the UI\'s premium ratio');
  assert.match(ingestion, /callPutCountRatio:/, 'the basis belongs in the name');
});
