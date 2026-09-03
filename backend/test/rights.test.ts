import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BusinessModeError,
  DEFAULT_BUSINESS_MODE,
  RightsViolationError,
  assertRights,
  classify,
  classifySource,
  datasetIdForSource,
  listDatasets,
  resolveBusinessMode,
  rightsSnapshot,
} from '../src/provenance/rights';

// ─── Mode resolution ────────────────────────────────────────────────────────

test('unset BUSINESS_MODE falls back to the restrictive mode', () => {
  assert.equal(resolveBusinessMode({} as NodeJS.ProcessEnv), 'PRIVATE_RESEARCH');
  assert.equal(DEFAULT_BUSINESS_MODE, 'PRIVATE_RESEARCH');
});

test('blank BUSINESS_MODE is treated as unset, not as a typo', () => {
  assert.equal(resolveBusinessMode({ BUSINESS_MODE: '   ' } as any), 'PRIVATE_RESEARCH');
});

test('both valid modes resolve, with surrounding whitespace tolerated', () => {
  assert.equal(resolveBusinessMode({ BUSINESS_MODE: 'PUBLIC_COMMERCIAL' } as any), 'PUBLIC_COMMERCIAL');
  assert.equal(resolveBusinessMode({ BUSINESS_MODE: ' PRIVATE_RESEARCH ' } as any), 'PRIVATE_RESEARCH');
});

test('a malformed BUSINESS_MODE throws rather than degrading in either direction', () => {
  // Degrading to the permissive branch would be a security hole; degrading
  // silently to the restrictive one would let an operator believe a setting
  // took effect that did not.
  for (const bad of ['PUBLIC', 'public_commercial', 'yes', 'true', 'COMMERCIAL']) {
    assert.throws(
      () => resolveBusinessMode({ BUSINESS_MODE: bad } as any),
      BusinessModeError,
      `expected "${bad}" to be rejected`,
    );
  }
});

// ─── Fail-closed classification ─────────────────────────────────────────────

test('UNVERIFIED is refused, in both modes and both capabilities', () => {
  for (const mode of ['PRIVATE_RESEARCH', 'PUBLIC_COMMERCIAL'] as const) {
    for (const cap of ['DISPLAY', 'PERSIST'] as const) {
      const d = classify('CBOE_CDN_DELAYED_CHAIN', cap, mode);
      assert.equal(d.rightsClass, 'UNVERIFIED');
      assert.equal(d.allowed, false, `${cap}/${mode} should be refused`);
      assert.match(d.reason, /uncertainty resolves to refusal/);
    }
  }
});

test('an unknown dataset id is refused, not defaulted', () => {
  const d = classify('SOME_NEW_VENDOR', 'PERSIST');
  assert.equal(d.allowed, false);
  assert.equal(d.rightsClass, 'UNKNOWN_DATASET');
  assert.match(d.reason, /not in the rights registry/);
});

test('an unmapped connector source is refused', () => {
  const d = classifySource('brand_new_feed', 'PERSIST');
  assert.equal(d.allowed, false);
  assert.equal(d.rightsClass, 'UNKNOWN_DATASET');
  assert.match(d.reason, /SOURCE_TO_DATASET/);
});

test('Yahoo is refused in private research too, because its terms bind the access method', () => {
  // The distinction that matters: Yahoo's prohibition is written against
  // automated access for ANY purpose, so "it is only for my own research" does
  // not escape it — unlike a redistribution restriction, which would.
  const d = classify('YAHOO_QUOTES', 'DISPLAY', 'PRIVATE_RESEARCH');
  assert.equal(d.allowed, false);
  assert.equal(d.rightsClass, 'PROHIBITED');
});

test('a refusal quotes the publisher\'s own words and links the terms', () => {
  const d = classify('YAHOO_QUOTES', 'PERSIST', 'PUBLIC_COMMERCIAL');
  assert.match(d.reason, /automated access to the service is prohibited/);
  assert.match(d.reason, /https:\/\//);
  assert.match(d.reason, /read 20\d\d-\d\d-\d\d/);
});

test('the Cboe entry records uncertainty about the CDN host rather than asserting a prohibition', () => {
  // The quoted prohibition is published on cboe.com/delayed_quotes/; the
  // connector reads cdn.cboe.com. Asserting PROHIBITED would claim a fact we
  // have not established; asserting PERMITTED would be worse.
  const ds = listDatasets().find((d) => d.id === 'CBOE_CDN_DELAYED_CHAIN')!;
  assert.equal(ds.host, 'cdn.cboe.com');
  assert.equal(ds.persist.PRIVATE_RESEARCH, 'UNVERIFIED');
  assert.match(ds.basis, /different host/);
  assert.match(ds.basis, /Open question/);
});

// ─── The permitted path ─────────────────────────────────────────────────────

test('Tradier is permitted for persistence in private research but not asserted for commercial', () => {
  assert.equal(classify('TRADIER_STREAM', 'PERSIST', 'PRIVATE_RESEARCH').allowed, true);
  const commercial = classify('TRADIER_STREAM', 'PERSIST', 'PUBLIC_COMMERCIAL');
  assert.equal(commercial.allowed, false);
  assert.equal(commercial.rightsClass, 'UNVERIFIED');
});

test('synthetic data is a rights non-issue and is classed accordingly', () => {
  // It is our own output. Keeping it out of the track record is a research
  // validity control, enforced elsewhere — conflating the two would make this
  // layer mean two different things.
  assert.equal(classify('SIMULATION', 'PERSIST', 'PUBLIC_COMMERCIAL').allowed, true);
});

test('assertRights throws a RightsViolationError carrying the decision', () => {
  assert.throws(
    () => assertRights('YAHOO_QUOTES', 'PERSIST'),
    (err: unknown) => {
      assert.ok(err instanceof RightsViolationError);
      assert.equal(err.decision.rightsClass, 'PROHIBITED');
      assert.equal(err.decision.capability, 'PERSIST');
      return true;
    },
  );
  assert.doesNotThrow(() => assertRights('TRADIER_STREAM', 'PERSIST', 'PRIVATE_RESEARCH'));
});

// ─── Registry integrity ─────────────────────────────────────────────────────

/**
 * Every `source` string that `ingestion/index.ts` can stamp on a RawPrint.
 *
 * This list is the regression guard. An unmapped source is not a crash — the
 * recorder refuses it and increments a counter — so it fails silently as
 * "nothing is being recorded", which is exactly the failure this whole
 * subsystem exists to prevent. Adding a connector means adding it here and to
 * the registry.
 */
const INGESTION_SOURCES = [
  'tradier',      // processMarketTick
  'polygon',      // polygon WS
  'simulation',   // simulatePrints
  'seed',         // simulatePrints, backdated at boot
  'marketdata',   // feedLegacy
  'schwab',       // feedLegacy
  'tastytrade',   // feedLegacy
  'yahoo',        // feedLegacy
] as const;

test('every source the ingestion pipeline can emit is mapped to a dataset', () => {
  for (const source of INGESTION_SOURCES) {
    const id = datasetIdForSource(source);
    assert.ok(id, `connector source "${source}" has no dataset mapping`);
    assert.ok(listDatasets().some((d) => d.id === id), `${id} should be in DATASETS`);
  }
});

test('every ingestion source resolves to a decision, never to UNKNOWN_DATASET', () => {
  for (const source of INGESTION_SOURCES) {
    const d = classifySource(source, 'PERSIST', 'PRIVATE_RESEARCH');
    assert.notEqual(
      d.rightsClass, 'UNKNOWN_DATASET',
      `"${source}" would be refused as unregistered, silently recording nothing`,
    );
  }
});

test('cboe and occ are the two live sources refused for persistence today', () => {
  // Documents the actual state: these are the only real feeds currently
  // working in production, and both are UNVERIFIED, so nothing they produce
  // enters the record. Change this test when the rights questions are answered.
  for (const source of ['cboe', 'cboe_options', 'occ']) {
    assert.equal(classifySource(source, 'PERSIST', 'PRIVATE_RESEARCH').allowed, false);
  }
});

test('every dataset states a basis and a terms URL', () => {
  for (const d of listDatasets()) {
    assert.ok(d.basis.trim().length > 20, `${d.id} needs a substantive basis`);
    assert.ok(d.termsUrl.length > 0, `${d.id} needs a terms URL`);
    assert.match(d.termsReadAt, /^\d{4}-\d{2}-\d{2}$/, `${d.id} needs a read date`);
  }
});

test('every dataset asserting PROHIBITED backs it with a quote', () => {
  // A prohibition with no quoted source is an opinion. This test is what stops
  // one being added later.
  for (const d of listDatasets()) {
    const asserts = [...Object.values(d.display), ...Object.values(d.persist)]
      .includes('PROHIBITED');
    if (asserts) {
      assert.ok(
        d.quotedRestriction && d.quotedRestriction.length > 20,
        `${d.id} claims PROHIBITED and must quote the restriction`,
      );
    }
  }
});

test('the health snapshot reports the mode in force and every class under it', () => {
  const snap = rightsSnapshot('PUBLIC_COMMERCIAL');
  assert.equal(snap.mode, 'PUBLIC_COMMERCIAL');
  const cboe = snap.datasets.find((d) => d.id === 'CBOE_CDN_DELAYED_CHAIN')!;
  assert.equal(cboe.persist, 'UNVERIFIED');
  assert.ok(cboe.quotedRestriction);
});

test('nothing manufactures option prints from an equity tick any more', () => {
  // `generateFlowFromSpot` handed a Finnhub EQUITY trade's price to
  // `simulatePrints` and put the manufactured OPTION prints on the tape, at
  // random, on roughly 15% of ticks — on a deployment that had paid for a real
  // feed. They were flagged `synthetic: true` and mapped to the SIMULATION
  // dataset so nothing entered the record under Finnhub's name, which made it
  // honest; it was still a terminal inventing option flow for a reader who had
  // every reason to think a configured vendor meant observed data.
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  const code = readFileSync(join(__dirname, '..', 'src', 'ingestion', 'index.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');

  assert.ok(!/generateFlowFromSpot/.test(code), 'the synthesizer survives');
  assert.ok(!/startFinnhubIngestion/.test(code), 'its only caller survives');
  // `simulatePrints` still backs simulation and seed mode. What must not come
  // back is a *credentialed* connector feeding it.
  assert.match(code, /function simulatePrints/, 'simulation mode still needs it');
});

test('finnhub is registered for what it now publishes, and stamps no prints', () => {
  // The old connector was mapped to SIMULATION because it published none of
  // Finnhub's data — it manufactured option prints from equity ticks. The new
  // one publishes Finnhub's own spot quotes, so it has a dataset entry of its
  // own with the terms read.
  //
  // It is absent from INGESTION_SOURCES on purpose: that list is every source
  // string a *RawPrint* can carry, and this connector emits none. A spot quote
  // is not a print.
  assert.equal(datasetIdForSource('finnhub'), 'FINNHUB_QUOTES');
  assert.ok(!INGESTION_SOURCES.includes('finnhub' as never));
});

test('the display board may be fetched; the track record may not be graded on it', () => {
  // The two axes, on the one dataset that separates them. Finnhub's terms
  // permit use and forbid sharing "data or derived results" with a third
  // party, and `/api/track-record` publishes derived results to anyone who can
  // reach it.
  assert.equal(classifySource('finnhub', 'DISPLAY', 'PRIVATE_RESEARCH').allowed, true);
  assert.equal(classifySource('finnhub', 'PERSIST', 'PRIVATE_RESEARCH').allowed, false);
  assert.equal(classifySource('finnhub', 'PERSIST', 'PUBLIC_COMMERCIAL').allowed, false);
  // And a commercial deployment may not show it either — that is redistribution.
  assert.equal(classifySource('finnhub', 'DISPLAY', 'PUBLIC_COMMERCIAL').allowed, false);
});

test('the grader reads only a source it is allowed to read', () => {
  // `getSpotPrice` is the grader's single mark source. Yahoo is refused for
  // access outright and Finnhub for persistence, so neither may appear there;
  // this is the one place a "just add a fallback" would route around a quoted
  // restriction.
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  const twelve = readFileSync(
    join(__dirname, '..', 'src', 'ingestion', 'connectors', 'twelveData.ts'), 'utf8');
  const spotPrice = twelve.slice(twelve.indexOf('export function getSpotPrice'));
  assert.match(spotPrice.slice(0, 200), /spotCache/, 'the mark comes from Twelve Data alone');
  assert.ok(!/finnhub|yahoo/i.test(spotPrice.slice(0, 200)));
});
