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
