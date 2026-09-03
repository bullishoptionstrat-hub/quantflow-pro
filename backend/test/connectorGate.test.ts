/**
 * The connector gate — the DISPLAY axis of the rights registry, enforced.
 *
 * These tests exist to hold two things that are easy to get wrong in opposite
 * directions:
 *
 *   1. An established, quoted prohibition must actually stop the connector.
 *      Before this gate, `YAHOO_QUOTES` was PROHIBITED for DISPLAY in both
 *      modes and the connector started anyway.
 *   2. It must stop *only* that. If UNVERIFIED refused a connector too,
 *      DISPLAY and PERSIST would resolve identically for every dataset and the
 *      registry's two-axis design would be dead weight — so there is a test
 *      below that fails if the two axes ever collapse into one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUSINESS_MODES,
  classify,
  classifySource,
  datasetIdForSource,
  getDataset,
  listDatasets,
  mayOperateConnector,
  refusedConnectors,
  type BusinessMode,
} from '../src/provenance/rights';

// ─── The refusal ────────────────────────────────────────────────────────────

test('an established prohibition stops the connector in every mode', () => {
  for (const mode of BUSINESS_MODES) {
    const d = mayOperateConnector('yahoo', mode);
    assert.equal(d.allowed, false, `yahoo should be refused in ${mode}`);
    assert.equal(d.rightsClass, 'PROHIBITED');
    assert.equal(d.datasetId, 'YAHOO_QUOTES');
  }
});

test('a refusal carries the publisher\'s own words and a terms URL', () => {
  // An operator reading /api/health must be able to check the claim without
  // reading the source. A refusal with no citation is an assertion.
  const d = mayOperateConnector('yahoo', 'PRIVATE_RESEARCH');
  const ds = getDataset('YAHOO_QUOTES')!;
  assert.ok(d.reason.includes(ds.quotedRestriction!), 'reason must quote the restriction');
  assert.ok(d.reason.includes(ds.termsUrl), 'reason must cite where it was read');
  assert.ok(d.reason.includes(ds.termsReadAt), 'reason must say when it was read');
});

test('a refusal says it is a decision, not a fault', () => {
  // `sourceErrors` is otherwise a list of vendor failures. A rights refusal
  // read as an outage gets "fixed" by adding an API key that will never help.
  const d = mayOperateConnector('yahoo', 'PRIVATE_RESEARCH');
  assert.match(d.reason, /not a fault/i);
});

test('every refused connector is listed for /api/health', () => {
  const refused = refusedConnectors('PRIVATE_RESEARCH');
  assert.ok(refused.some((d) => d.source === 'yahoo'));
  for (const d of refused) {
    assert.equal(d.allowed, false);
    assert.ok(d.reason.length > 40, `${d.source} needs a substantive reason`);
  }
});

test('refusedConnectors agrees with mayOperateConnector for every mapped source', () => {
  for (const mode of BUSINESS_MODES) {
    const listed = new Set(refusedConnectors(mode).map((d) => d.source));
    for (const source of MAPPED_SOURCES) {
      const allowed = mayOperateConnector(source, mode).allowed;
      assert.equal(
        listed.has(source), !allowed,
        `${source} in ${mode}: the list and the gate disagree`,
      );
    }
  }
});

// ─── The deliberate narrowness ──────────────────────────────────────────────

test('UNVERIFIED does not stop a connector', () => {
  // The registry's own reasoning: an unverified source "is a much worse basis
  // for a permanent record than for an ephemeral panel". Refusing it here
  // would silently resolve an open question in the restrictive direction and
  // erase the difference between "we asked and they said no" and "we have not
  // established this".
  for (const source of ['cboe', 'cboe_options', 'occ']) {
    const d = mayOperateConnector(source, 'PRIVATE_RESEARCH');
    assert.equal(d.rightsClass, 'UNVERIFIED', `${source} should be UNVERIFIED today`);
    assert.equal(d.allowed, true, `${source} should still run`);
  }
});

test('an UNVERIFIED source still reports its class and its restriction', () => {
  // It runs, but nobody gets to forget why it is a question.
  const d = mayOperateConnector('occ', 'PRIVATE_RESEARCH');
  assert.match(d.reason, /UNVERIFIED/);
  assert.ok(d.reason.includes(getDataset('OCC_VOLUME_TOTALS')!.termsUrl));
});

test('an UNVERIFIED source that is allowed to display is still refused persistence', () => {
  // This is the whole point of two axes. If this ever fails, the gate has
  // leaked into the persistence decision.
  for (const source of ['cboe', 'occ']) {
    assert.equal(mayOperateConnector(source, 'PRIVATE_RESEARCH').allowed, true);
    assert.equal(classifySource(source, 'PERSIST', 'PRIVATE_RESEARCH').allowed, false);
  }
});

test('DISPLAY and PERSIST still resolve differently somewhere', () => {
  // A canary for the collapse described at the top of this file: if a future
  // edit makes the gate refuse everything `classify` refuses, this fails.
  const divergent = listDatasets().flatMap((ds) =>
    BUSINESS_MODES.filter((m) => {
      const source = SOURCE_FOR_DATASET[ds.id];
      if (!source) return false;
      return mayOperateConnector(source, m).allowed
        !== classify(ds.id, 'PERSIST', m).allowed;
    }).map((m) => `${ds.id}/${m}`),
  );
  assert.ok(
    divergent.length > 0,
    'no dataset distinguishes DISPLAY from PERSIST — the two-axis design is dead code',
  );
});

test('an unregistered connector is not stopped by the gate', () => {
  // FRED, CoinGecko, Reddit, NewsAPI, Stooq, TwelveData, FMP and FlashAlpha
  // emit no prints and have no dataset entry. Refusing them here would take
  // out the macro, news and sentiment pages over a registry coverage gap
  // rather than over a rights finding — which reads as the gate malfunctioning.
  for (const source of ['fred', 'coingecko', 'reddit', 'newsapi', 'stooq', 'twelvedata', 'fmp', 'flashalpha']) {
    assert.equal(datasetIdForSource(source), undefined, `${source} is unmapped today`);
    const d = mayOperateConnector(source, 'PRIVATE_RESEARCH');
    assert.equal(d.allowed, true, `${source} should not be stopped by the gate`);
    assert.equal(d.rightsClass, 'UNREGISTERED');
  }
});

test('an unregistered connector is still refused for persistence', () => {
  // The gate lets it run; it does not launder it into the record.
  const d = classifySource('fred', 'PERSIST', 'PRIVATE_RESEARCH');
  assert.equal(d.allowed, false);
  assert.equal(d.rightsClass, 'UNKNOWN_DATASET');
});

// ─── No way around it ───────────────────────────────────────────────────────

const INGESTION_SRC = readFileSync(
  join(__dirname, '..', 'src', 'ingestion', 'index.ts'), 'utf8',
);

test('the gate has no environment override', () => {
  // A bypass flag over an established, quoted prohibition is worse than no
  // gate: it lets the refusal be switched off by whoever is least likely to
  // have read the terms.
  const rightsSrc = readFileSync(
    join(__dirname, '..', 'src', 'provenance', 'rights.ts'), 'utf8',
  );
  const envRefs = [...rightsSrc.matchAll(/env\.([A-Z_0-9]+)/g)].map((m) => m[1]!);
  assert.deepEqual(
    [...new Set(envRefs)], ['BUSINESS_MODE'],
    'rights.ts should read no environment variable but BUSINESS_MODE',
  );
  assert.ok(
    !/ALLOW_PROHIBITED|SKIP_RIGHTS|IGNORE_RIGHTS|FORCE_/i.test(INGESTION_SRC),
    'no bypass flag in the ingestion path',
  );
});

test('every connector start goes through the gate', () => {
  // `startConnector` covers the thirteen in the Promise.allSettled block;
  // `startCboeOptions` and `startOcc` are called directly and need their own.
  assert.match(
    INGESTION_SRC,
    /function startConnector[\s\S]{0,600}?gateFor\(name\)[\s\S]{0,200}?markRefused/,
    'startConnector must consult the gate before calling start()',
  );
  for (const fn of ['startCboeOptions', 'startOcc']) {
    assert.match(
      INGESTION_SRC, new RegExp(`function ${fn}\\(\\): void \\{[\\s\\S]{0,200}?gateFor\\(`),
      `${fn} is started outside startConnector and needs its own gate check`,
    );
  }
});

test('the refusal is checked before the connector is started, not after', () => {
  // Ordering is the whole substance of the gate. `start()` is what issues the
  // request, and the request is the act the terms prohibit — filtering its
  // output afterwards would already have made the call.
  const body = INGESTION_SRC.slice(INGESTION_SRC.indexOf('function startConnector'));
  const gateAt = body.indexOf('gateFor(name)');
  const startAt = body.indexOf('return start()');
  assert.ok(gateAt >= 0 && startAt >= 0);
  assert.ok(gateAt < startAt, 'the gate must run before start()');
});

test('the legacy print feed refuses a gated source too', () => {
  // Defense in depth on the one path that carries prints to the flow engine.
  assert.match(
    INGESTION_SRC,
    /const feedLegacy = \(source: string\)[\s\S]{0,600}?gateFor\(source\)[\s\S]{0,120}?return;/,
    'feedLegacy must drop prints from a refused source',
  );
});

test('Yahoo\'s non-print publication path is gated as well', () => {
  // onYahooFlow is covered by feedLegacy; onYahooQuote is not a print and goes
  // straight out over the socket as `spot_update`.
  assert.match(
    INGESTION_SRC,
    /gateFor\('yahoo'\)\.allowed\) \{\s*\n\s*onYahooQuote/,
    'the Yahoo spot-quote subscription must be behind the gate',
  );
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** Every connector source string the registry maps, read from the registry. */
const MAPPED_SOURCES = [
  'tradier', 'polygon', 'cboe', 'cboe_options', 'cboeOptions', 'occ', 'yahoo',
  'finra', 'marketdata', 'schwab', 'tastytrade', 'simulation', 'seed',
].filter((s) => datasetIdForSource(s));

test('MAPPED_SOURCES has not drifted from the registry', () => {
  // If a source is added to SOURCE_TO_DATASET and not here, the agreement test
  // above silently stops covering it.
  const mapped = MAPPED_SOURCES.length;
  const known = new Set(
    ['tradier', 'polygon', 'cboe', 'cboe_options', 'cboeOptions', 'occ', 'yahoo',
     'finra', 'marketdata', 'schwab', 'tastytrade', 'simulation', 'seed']
      .filter((s) => datasetIdForSource(s)),
  ).size;
  assert.equal(mapped, known);
  assert.equal(mapped, 13, 'SOURCE_TO_DATASET changed — update MAPPED_SOURCES');
});

/** One representative source per dataset, for the divergence canary. */
const SOURCE_FOR_DATASET: Record<string, string> = {
  TRADIER_STREAM: 'tradier',
  POLYGON_OPTIONS: 'polygon',
  CBOE_CDN_DELAYED_CHAIN: 'cboe',
  OCC_VOLUME_TOTALS: 'occ',
  YAHOO_QUOTES: 'yahoo',
  FINRA_SHORT_VOLUME: 'finra',
  MARKETDATA_APP: 'marketdata',
  SCHWAB_API: 'schwab',
  TASTYTRADE_API: 'tastytrade',
  SIMULATION: 'simulation',
};

test('every dataset has a representative source for the canary', () => {
  for (const ds of listDatasets()) {
    const source = SOURCE_FOR_DATASET[ds.id];
    assert.ok(source, `${ds.id} needs an entry in SOURCE_FOR_DATASET`);
    assert.equal(datasetIdForSource(source!), ds.id);
  }
});
