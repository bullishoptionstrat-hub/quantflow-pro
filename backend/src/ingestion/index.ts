/**
 * QuantFlow Pro — Ingestion Pipeline v3
 *
 * Classification and scoring run through `flowEngineAdapter` (the vendored
 * flow-engine), not the legacy heatScore/sweepDetector pair. Every source
 * normalizes to a RawPrint and funnels through `ingestPrint()`; the engine
 * emits classified signals on burst close, which are batched to Socket.IO.
 *
 * Sources: Tradier, Polygon + 13 free connectors:
 *   FlashAlpha · MarketData.app · Schwab · Tastytrade · TwelveData · FMP
 *   CoinGecko · FRED · Reddit · NewsAPI · CBOE · Yahoo · Stooq
 */
import axios from 'axios';
import WebSocket from 'ws';
import { fetchCboeChain, getCboeSnapshot, getCboeSymbols } from './connectors/cboeOptions';
import { fetchOccVolume, getOccVolume } from './connectors/occ';
import { describeHttpError } from './httpError';
import { probeAll, type EntitlementResult } from './entitlement';
import { resolveMark, markSourceStandings, markRightsClass } from './markSources';
import {
  CoverageRecorder, recoverMissedWindow, type CoverageSample,
} from '../persistence/coverage';
import type { CollectionGap } from '../persistence/types';
import {
  ingestPrint, drainIdle, resetDaily, onSignal,
  type RawPrint, type WireFlowEvent,
} from './flowEngineAdapter';
import {
  initPersistence, describePersistence, SignalGrader,
  type RecoveryReport,
  type SignalRecord,
  type SignalStore,
} from '../persistence';
import {
  rightsSnapshot, mayOperateConnector, refusedConnectors,
  type ConnectorGateDecision,
} from '../provenance/rights';

// ─── 13 New Connectors ───────────────────────────────────────────────────────
import { startFlashAlpha, getFlashGEX } from './connectors/flashAlpha';
import { startMarketData, onMarketDataFlow } from './connectors/marketData';
import { startSchwab, onSchwabFlow } from './connectors/schwab';
import { startTastytrade, onTastytradeFlow } from './connectors/tastytrade';
import {
  startTwelveData, onTwelveDataSpot, onTwelveDataHealth,
  getSpotQuotes as getTwelveDataSpotQuotes, getSpotPrice,
} from './connectors/twelveData';
import {
  startFMP, getEarnings, getInsiderTrades, getFMPNews,
} from './connectors/fmp';
import { startFinnhub, onFinnhubHealth, getFinnhubSpotQuotes } from './connectors/finnhub';
import type { SpotQuote } from './connectors/twelveData';
import {
  startCoinGecko, onCoinGeckoUpdate, onCoinGeckoHealth,
  getCryptoQuotes, getCryptoGlobal,
} from './connectors/coinGecko';
import {
  startFRED, onFREDUpdate, onFREDHealth,
  getMacroData, getMacroValue,
} from './connectors/fred';
import {
  startReddit, onRedditSentiment,
  getRedditSentiment, getSymbolSentiment,
} from './connectors/reddit';
import {
  startNewsAPI, onNewsHeadline, getNewsHeadlines,
} from './connectors/newsApi';
import {
  startEventRegistry, onEventRegistryHeadline, onEventRegistryHealth,
  getEventRegistryHeadlines,
} from './connectors/eventRegistry';
import {
  startCBOE, onCBOEData, getCBOEData,
} from './connectors/cboe';
import {
  startYahoo, onYahooFlow, onYahooQuote, getYahooQuotes,
} from './connectors/yahoo';
import {
  startStooq, onStooqQuote, onStooqHealth, getStooqQuotes,
} from './connectors/stooq';

// ─── Re-export all sub-connector getters for route handlers ─────────────────
export {
  getFlashGEX,
  getSpotPrice,
  getEarnings, getInsiderTrades, getFMPNews,
  getCryptoQuotes, getCryptoGlobal,
  getMacroData, getMacroValue,
  getRedditSentiment, getSymbolSentiment,
  getNewsHeadlines,
  getCBOEData,
  getYahooQuotes,
  getStooqQuotes,
};

// ─── Types (re-exported for routes) ────────────────────────────────────────

/**
 * Wire contract for flow events — matches `frontend/lib/types.ts` FlowEvent.
 * (The pre-v3 backend emitted a camelCase shape the frontend never read
 * correctly; the two are now the same contract.)
 */
export type FlowEvent = WireFlowEvent;

/**
 * The camelCase shape still emitted by the chain-snapshot connectors
 * (marketData, schwab, tastytrade, yahoo). Converted to RawPrint on arrival.
 */
export interface LegacyFlowEvent {
  id: string;
  timestamp: string;
  symbol: string;
  expiration: string;
  strike: number;
  callPut: 'C' | 'P';
  type: 'SWEEP' | 'BLOCK' | 'SPLIT';
  size: number;
  premium: number;
  /**
   * Absent when the source carried no NBBO for the contract.
   *
   * Bid/ask displacement is the score's largest single component (0-35 of
   * 100), so a score computed with a missing quote filled in as zero is not
   * a less certain score — it is a different quantity under the same name,
   * and it read as maximum aggression because a fill above a zero bid looks
   * like one. `legacyEventToPrint` discards this field either way; the engine
   * scores every print itself.
   */
  heatScore?: number;
  sentiment: 'bullish' | 'bearish' | 'neutral';
  source: string;
  bid?: number;
  ask?: number;
  iv?: number;
  delta?: number;
  exchange?: string;
  conditions?: string[];
  unusualScore?: number;
}

export interface DarkPoolPrint {
  id: string;
  timestamp: string;
  symbol: string;
  price: number;
  size: number;
  notional: number;
  exchange: string;
  source: string;
}

export interface GEXLevel {
  strike: number;
  gex: number;
  /** See CboeGexLevel.dex — the sign is the contract's own, not a convention. */
  dex: number;
  /** Contracts with OI and gamma but no delta, excluded from `dex`. */
  dexMissing: number;
  callOI: number;
  putOI: number;
  callGamma: number;
  putGamma: number;
  callDelta: number;
  putDelta: number;
}

// ─── In-memory stores ───────────────────────────────────────────────────────

const MAX_FLOW_EVENTS = 500;
const MAX_DP_PRINTS = 200;

let flowEvents: FlowEvent[] = [];
let darkPoolPrints: DarkPoolPrint[] = [];
let gexCache: Record<string, { levels: GEXLevel[]; fetchedAt: number }> = {};

let ioInstance: any = null;
let ingestionActive = false;
// `refused` is not a failure state. It means the rights registry established a
// prohibition on the source and the connector was never started — a decision,
// not an outage. Kept distinct from `disabled` (no credentials) and `error`
// (the vendor said no) so nobody tries to fix it by adding an API key.
let sources: Record<string, 'connected' | 'error' | 'disabled' | 'refused'> = {};
// Why a source is in 'error'. Surfaced via /api/health because the hosting
// platform's logs aren't always reachable when diagnosing a live deploy.
// Status codes and messages only — never credentials.
let sourceErrors: Record<string, string> = {};

// ─── Data-rights gate ───────────────────────────────────────────────────────

/**
 * Gate decisions, resolved once per source and memoized.
 *
 * `feedLegacy` consults the gate on every print, so this is a per-print call
 * on the hot path — and `mayOperateConnector` calls `resolveBusinessMode()`,
 * which throws on a malformed BUSINESS_MODE. That throw is meant to stop the
 * process at boot, not to surface from inside a print handler where the
 * surrounding `catch` would report it as a vendor error. Memoizing puts it on
 * the first call, which is the connector-start path.
 */
const gateCache = new Map<string, ConnectorGateDecision>();

function gateFor(source: string): ConnectorGateDecision {
  let d = gateCache.get(source);
  if (!d) {
    d = mayOperateConnector(source);
    gateCache.set(source, d);
  }
  return d;
}

/**
 * Refuse a source and say so on /api/health. Idempotent — the print-level
 * guard and the connector-level guard can both reach it for the same source.
 */
function markRefused(source: string, d: ConnectorGateDecision): void {
  sources[source] = 'refused';
  sourceErrors[source] = d.reason;
}

/**
 * A connector that has no key, and which variable would give it one.
 *
 * `startConnector` says this for the thirteen free-tier connectors from
 * `CONNECTOR_CREDENTIALS`. Tradier and Polygon start on their own
 * paths and set `disabled` with no reason at all — so /api/health reported
 * those sources as off and named nothing an operator could act on, which is
 * the gap the credentials table was introduced to close everywhere else.
 */
function markNoCredentials(source: string, vars: string[]): void {
  sources[source] = 'disabled';
  sourceErrors[source] =
    `No credentials — ${vars.join(', ')} ${vars.length === 1 ? 'is' : 'are'} not set. ` +
    `The connector is not contributing data.`;
}

/**
 * What each vendor said when asked whether this key reaches its data.
 *
 * Separate from `sources` on purpose, and it must stay separate. `sources` is
 * owned by the poller that writes it, and the one time two writers shared a
 * health field the loser was the truth: `startConnector` recorded what
 * `start()` returned once and overwrote a failure the connector had already
 * reported (CLAUDE.md, the dead-sources note). The entitlement probe is a
 * second opinion, not a second author — it answers a question no poller asks,
 * and it never decides whether a source is `connected`.
 *
 * Empty until the first probe resolves, which is why each entry carries the
 * instant it was taken: an entitlement is a fact about a moment, and a plan
 * that lapses at noon reads as entitled until the next sweep.
 */
const entitlement: Record<string, EntitlementResult & { checkedAt: string }> = {};

/** Hourly, so a plan that lapses mid-session is noticed without a restart. */
const ENTITLEMENT_REPROBE_MS = 60 * 60_000;

/**
 * Ask the vendors, at boot and hourly after.
 *
 * Why at boot at all, when a failing poller already reports an error: because
 * the poller reports `error` with a body a human has to read, and only after
 * its own cycle has run — hourly, for some. This answers a narrower question
 * uniformly and immediately: `refused` (the plan does not cover it) versus
 * `rejected` (the key is wrong) versus `unreachable` (no answer). Twelve Data
 * has no options poller reporting here at all, and it is the source every
 * graded outcome derives from.
 *
 * Never blocks startup and never throws into it. A probe that fails is an
 * absence of information, and `probeAll` already resolves rather than rejects;
 * the `catch` is for the impossible case, so an unhandled rejection cannot take
 * the ingestion process down over a diagnostic.
 *
 * Cost, since these are metered requests: three sources at most, once an hour —
 * 72 calls a day against Twelve Data's free 800/day, and a rounding error
 * against Polygon's per-minute limit.
 */
function startEntitlementProbes(): void {
  const sweep = (): void => {
    void probeAll(process.env)
      .then((results) => {
        const at = new Date().toISOString();
        for (const r of results) {
          entitlement[r.source] = { ...r, checkedAt: at };
          if (r.state === 'refused' || r.state === 'rejected') {
            console.log(`[entitlement] ${r.source}: ${r.state} — ${r.detail}`);
          }
        }
      })
      .catch(() => { /* a diagnostic must not be able to end the process */ });
  };

  sweep();
  setInterval(sweep, ENTITLEMENT_REPROBE_MS).unref();
}

/**
 * Fold a denial into the degraded-notes channel — and only into that one.
 *
 * `sources` is deliberately not written here. The poller owns that field, and
 * the one time two writers shared a health field the loser was the truth:
 * `startConnector` recorded what `start()` returned once and overwrote a
 * failure the connector had already reported. So an operator reading a board
 * where polygon says `connected` still sees that its plan refuses the endpoint,
 * without the probe and the poller fighting over a single word.
 *
 * `unreachable`, `unknown` and `unprobed` produce no note on purpose: none of
 * them is evidence of anything, and a permanent "we could not check" line on a
 * status board is noise that teaches an operator to stop reading it.
 *
 * Exported because it is the only interesting behaviour in the projection, and
 * a seam beats a test-only setter on module state.
 */
export function mergeEntitlementNotes(
  notes: Record<string, string>,
  verdicts: Record<string, { state: string; detail: string }>,
): Record<string, string> {
  for (const [source, r] of Object.entries(verdicts)) {
    if (r.state !== 'refused' && r.state !== 'rejected') continue;
    const note = `entitlement ${r.state}: ${r.detail}`;
    notes[source] = notes[source] ? `${notes[source]}; ${note}` : note;
  }
  return notes;
}

/** The probe's verdicts, for /api/health. Public — see `describeHttpError`. */
export function getEntitlement(): Record<string, EntitlementResult & { checkedAt: string }> {
  return { ...entitlement };
}

// ─── Public getters ─────────────────────────────────────────────────────────

export function getRecentFlow(): FlowEvent[] {
  // Newest first. Bursts finalize per underlying, so a cluster that closes
  // late can carry an older timestamp than one already emitted — insertion
  // order alone does not guarantee a descending feed.
  return [...flowEvents].sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
  );
}

export function getDarkPoolPrints(): DarkPoolPrint[] {
  return [...darkPoolPrints];
}

export function getGEXLevels(symbol: string): GEXLevel[] {
  // CBOE publishes per-contract gamma, delta and open interest, so this is a
  // direct computation from the vendor's own numbers.
  //
  // There is no fallback, and there used to be. `generateSyntheticGEX` built
  // thirty-one strikes from `Math.random()` over a hardcoded 2024 spot map
  // (`SPX: 5800`, `NVDA: 140`) and seeded four symbols with it at boot. It is
  // the same shape as `buildMockChain`, `generateSeedFlow`, `generateDarkPool`
  // and `generateQuotes`, all deleted for the same reason: a fabricated gamma
  // profile looks exactly like a real one, and the only thing standing between
  // it and a chart was a `realData: false` flag the reader had to notice.
  //
  // It was already being refused — `GEXChart` treats `realData === false` as
  // unavailable and draws nothing — so those numbers existed solely to be
  // thrown away, with a stale price map sitting in the tree for the next
  // caller to pick up. An empty list is the honest answer to "CBOE has not
  // been polled for this symbol", and the page has an empty state for it.
  const snap = getCboeSnapshot(symbol);
  if (snap && snap.gex.length > 0) {
    gexCache[symbol] = { levels: snap.gex, fetchedAt: Date.now() };
    return snap.gex;
  }

  // The last real chain, briefly, so a poll in flight does not blank the page.
  const cached = gexCache[symbol];
  if (cached && Date.now() - cached.fetchedAt < 60_000) return cached.levels;
  return [];
}

/** The same aggregation restricted to contracts expiring today, if any. */
export function getZeroDteLevels(symbol: string) {
  return getCboeSnapshot(symbol)?.zeroDte ?? null;
}

export function getFlowStats() {
  const events = flowEvents;
  const calls = events.filter((e) => e.option_type === 'C');
  const puts = events.filter((e) => e.option_type === 'P');
  const callPremium = calls.reduce((s, e) => s + e.total_premium, 0);
  const putPremium = puts.reduce((s, e) => s + e.total_premium, 0);
  const totalPremium = callPremium + putPremium;

  return {
    totalTrades: events.length,
    totalPremium,
    callPremium,
    putPremium,
    /**
     * Calls per put, by **contract count** — not by premium, and not the way
     * up the terminal's tile reads.
     *
     * It was `callPutRatio`, and the flow page's tile was labelled `P/C RATIO`
     * while computing `putPremium / callPremium`: the other direction, on a
     * different basis, under a name a reader would match to this one. The
     * macro page's Cboe put/call is a third quantity again (exchange volume).
     * Nothing consumes this endpoint today, which is exactly when a name is
     * cheap to fix.
     *
     * `null` rather than `0` when there are no puts: zero reads as "no calls".
     */
    callPutCountRatio: puts.length > 0 ? parseFloat((calls.length / puts.length).toFixed(2)) : null,
    sweepCount: events.filter((e) => e.order_type === 'SWEEP').length,
    blockCount: events.filter((e) => e.order_type === 'BLOCK').length,
    splitCount: events.filter((e) => e.order_type === 'SPLIT').length,
    multiLegCount: events.filter((e) => e.order_type === 'MULTI_LEG').length,
    bullishCount: events.filter((e) => e.sentiment === 'BULLISH').length,
    bearishCount: events.filter((e) => e.sentiment === 'BEARISH').length,
    /** Side could not be inferred — NBBO missing or stale. Not a direction. */
    ambiguousCount: events.filter((e) => e.side === 'AMBIGUOUS').length,
    unusualCount: events.filter((e) => e.is_unusual).length,
    syntheticCount: events.filter((e) => e.synthetic).length,
    sources,
  };
}

export function getIngestionStatus() {
  // A connected source can still be degraded. Polygon's trades feed working
  // while its NBBO lookups are refused means prints arrive and every one of
  // them is non-directional — visible nowhere if the only vocabulary is
  // connected/error.
  const notes: Record<string, string> = {};
  if (polygonQuoteNote) notes['polygon'] = polygonQuoteNote;
  for (const [source, note] of Object.entries(connectorNotes)) {
    notes[source] = notes[source] ? `${notes[source]}; ${note}` : note;
  }
  for (const [source, count] of Object.entries(unparsedFrames)) {
    const existing = notes[source];
    const note = `${count} stream frame(s) could not be parsed`;
    notes[source] = existing ? `${existing}; ${note}` : note;
  }

  mergeEntitlementNotes(notes, entitlement);

  return {
    active: ingestionActive,
    sources,
    sourceErrors,
    sourceNotes: notes,
    /**
     * What the vendor said, per source, and when. Distinct from `sources`:
     * that is "is data arriving?", this is "would it be allowed to?".
     * Every string here has been through `describeHttpError`, which carries
     * the vendor's own words and scrubs anything key-shaped — several of
     * these probes put the key in the query string.
     */
    entitlement: getEntitlement(),
    /**
     * The grader's mark registry: which sources could price an underlying,
     * and why each is in or out. Published because "every outcome is
     * UNGRADED" used to be answerable only by knowing that one hard-wired
     * vendor supplied the price — and the registry is short enough that a
     * single refusal still grades nothing.
     */
    markSources: markSourceStandings(),
    // Listed even before the connector loop has run, so a refusal is visible
    // on a cold /api/health rather than only after the first poll tick. Every
    // string here is a quoted public restriction and a terms URL — nothing
    // credential-shaped, same rule as `sourceErrors`.
    rightsRefusals: refusedConnectors().map((d) => ({
      source: d.source,
      datasetId: d.datasetId,
      rightsClass: d.rightsClass,
      mode: d.mode,
      reason: d.reason,
    })),
    occ: getOccVolume(),
  };
}

/** Symbols with a real (non-synthetic) CBOE chain loaded. */
export function getRealGexSymbols(): string[] {
  return getCboeSymbols();
}

/** Delayed-but-real unusual options activity, ranked by notional. */
export function getUnusualActivity(symbol?: string) {
  const syms = symbol ? [symbol.toUpperCase()] : getCboeSymbols();
  const out = syms.flatMap((sy) => {
    const snap = getCboeSnapshot(sy);
    return snap ? snap.unusual.map((u) => ({ ...u, asOf: snap.asOf, delayedMinutes: snap.delayedMinutes })) : [];
  });
  return out.sort((a, b) => b.notional - a.notional);
}

// ─── Initializer ────────────────────────────────────────────────────────────

// ─── Connector credentials ──────────────────────────────────────────────────

/**
 * What each connector needs in the environment before it can do any work.
 *
 * This exists because the connectors return early and *resolve* when their key
 * is missing — so the `.then()` that marks them `connected` fired for a
 * connector that had just decided to do nothing. Every keyless source
 * therefore reported `connected` on /api/health while fetching nothing at all,
 * which is precisely the kind of confident wrong answer `sourceErrors` and
 * `describeHttpError` were introduced to stop.
 *
 * An empty list means the source genuinely needs no credentials: CoinGecko has
 * a public endpoint, and CBOE / OCC / Stooq / Yahoo are unauthenticated fetches.
 *
 * Variable NAMES are safe to publish — /api/health is unauthenticated, but the
 * names are already documented in `.env.example`. Values never appear here.
 */
export const CONNECTOR_CREDENTIALS: Readonly<Record<string, readonly string[]>> = {
  // These two start on their own paths rather than through `startConnector`,
  // and were left out of this table for that reason. (Finnhub was the third;
  // it is gone — see the note where its connector used to be.) They
  // still *need* credentials, and leaving them out meant nothing could answer
  // "which variable turns Tradier on" — `tools/collection/doctor.ts` asked and
  // got "(none listed)" for the two most likely options feeds.
  tradier: ['TRADIER_TOKEN'],
  polygon: ['POLYGON_API_KEY'],

  finnhub: ['FINNHUB_API_KEY'],

  flashalpha: ['FLASHALPHA_API_KEY'],
  marketdata: ['MARKETDATA_TOKEN'],
  schwab: ['SCHWAB_APP_KEY', 'SCHWAB_APP_SECRET', 'SCHWAB_REFRESH_TOKEN'],
  tastytrade: ['TASTYTRADE_USER', 'TASTYTRADE_PASS'],
  twelvedata: ['TWELVE_DATA_API_KEY'],
  fmp: ['FMP_API_KEY'],
  newsapi: ['NEWS_API_KEY'],
  eventregistry: ['EVENT_REGISTRY_API_KEY'],
  fred: ['FRED_API_KEY'],
  reddit: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET'],
  // Keyless by design.
  coingecko: [],
  cboe: [],
  yahoo: [],
  stooq: [],
};

/** Which of a connector's required variables are unset or blank. */
export function missingCredentials(
  name: string, env: NodeJS.ProcessEnv = process.env,
): string[] {
  return (CONNECTOR_CREDENTIALS[name] ?? []).filter(
    (k) => !(env[k] ?? '').trim(),
  );
}

/**
 * Start one connector and report what actually happened.
 *
 * A resolved promise is NOT evidence the connector is running — it resolves
 * just as happily after returning early for a missing key. So the credentials
 * are checked directly, and a connector with none is reported `disabled` with
 * the variable names needed to enable it.
 */
function startConnector(name: string, start: () => Promise<unknown>): Promise<void> {
  // The rights gate runs before the connector does. A refused source must not
  // be started and then filtered downstream: `start()` is what opens the
  // socket or issues the fetch, and the request itself is the act the
  // publisher's terms prohibit.
  const gate = gateFor(name);
  if (!gate.allowed) {
    markRefused(name, gate);
    return Promise.resolve();
  }

  return start()
    .then(() => {
      const missing = missingCredentials(name);
      if (missing.length > 0) {
        sources[name] = 'disabled';
        sourceErrors[name] =
          `No credentials — ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} ` +
          `not set. The connector started and returned immediately without fetching ` +
          `anything; it is not contributing data.`;
      } else if (sources[name] === 'error') {
        // The connector reported its own failure while `start()` was still
        // running — Stooq's first fetch cycle completes before `startStooq`
        // resolves — and that report is the better evidence. "start() returned
        // without throwing" is the coarsest possible health signal, and
        // overwriting a specific failure with it is how a source that had just
        // said it was broken came back as `connected`.
      } else {
        sources[name] = 'connected';
        delete sourceErrors[name];
      }
    })
    .catch((err) => {
      sources[name] = 'disabled';
      sourceErrors[name] = describeHttpError(err);
    });
}

export function startIngestion(io: any): void {
  ioInstance = io;
  ingestionActive = true;

  startSignalHistory();

  // Seed with realistic data immediately
  seedInitialData();

  startCboeOptions();
  startOcc();

  // ── Legacy connectors ──
  startTradierIngestion();
  startPolygonIngestion();

  // ── 13 New connectors ──
  // The chain-snapshot connectors still build their own camelCase events with
  // the legacy scorer; convert them to RawPrints so classification and scoring
  // happen in one place. (Their internal heat/type values are discarded.)
  const feedLegacy = (source: string) => (e: any) => {
    // Second guard, generic across all four legacy feeds. `startConnector`
    // already keeps a refused connector from running; this is what holds if a
    // connector ever acquires another way to be started, or keeps a poll timer
    // across a restart. A refused source must not reach the tape by any route.
    const gate = gateFor(source);
    if (!gate.allowed) { markRefused(source, gate); return; }
    const print = legacyEventToPrint(e, source);
    if (print) emitSignals(ingestPrint(print));
  };
  onMarketDataFlow(feedLegacy('marketdata'));
  onSchwabFlow(feedLegacy('schwab'));
  onTastytradeFlow(feedLegacy('tastytrade'));
  onYahooFlow(feedLegacy('yahoo'));

  // Wire quote updates to broadcast via Socket.IO
  onTwelveDataSpot((q) => {
    if (ioInstance) ioInstance.emit('spot_update', q);
  });
  // The same reason as Stooq, CoinGecko and FRED below — and the sharpest
  // case of it. `markSources` lists exactly `['twelvedata']`, so this is the
  // source every graded outcome takes its mark from. It reported `connected`
  // with no error and no note while every 60s poll came back HTTP 429, which
  // is indistinguishable from a working feed in a quiet market.
  //
  // `degraded` routes through the note channel rather than `sourceErrors`
  // because the stream and the batch fail independently: a dead REST fallback
  // while the socket delivers is a real fact about the deployment, not an
  // outage, and the settings page already renders connected-with-a-note as
  // DEGRADED.
  onTwelveDataHealth((h) => {
    if (h.ok) {
      sources['twelvedata'] = 'connected';
      delete sourceErrors['twelvedata'];
      if (h.degraded && h.reason) connectorNotes['twelvedata'] = h.reason;
      else delete connectorNotes['twelvedata'];
    } else {
      sources['twelvedata'] = 'error';
      sourceErrors['twelvedata'] = h.reason ?? 'Twelve Data fetch failed.';
      delete connectorNotes['twelvedata'];
    }
  });
  // Yahoo has a second publication path that is not a print: the spot quote
  // goes straight out over the socket. Subscribing to it for a refused source
  // would republish exactly the data the gate exists to stop.
  if (gateFor('yahoo').allowed) {
    onYahooQuote((q) => {
      if (ioInstance) ioInstance.emit('spot_update', q);
    });
  }
  onStooqQuote((q) => {
    if (ioInstance) ioInstance.emit('stooq_update', q);
  });
  // Stooq reports on every cycle, not just the first. `startConnector` records
  // what `start()` returned and never looks again, so a source that starts
  // clean and dies an hour later keeps reporting `connected` — and Stooq is
  // now serving a browser-verification challenge in place of its CSV.
  onStooqHealth((h) => {
    if (h.ok) {
      sources['stooq'] = 'connected';
      delete sourceErrors['stooq'];
    } else {
      sources['stooq'] = 'error';
      sourceErrors['stooq'] = h.reason ?? 'Stooq fetch failed.';
    }
  });

  onFinnhubHealth((h) => {
    if (h.ok) {
      sources['finnhub'] = 'connected';
      delete sourceErrors['finnhub'];
    } else {
      sources['finnhub'] = 'error';
      sourceErrors['finnhub'] = h.reason ?? 'Finnhub fetch failed.';
    }
  });

  // Same reason as Stooq above: `startConnector` records what `start()`
  // returned once, so a CoinGecko that starts clean and is rate-limited an
  // hour later kept reporting `connected` while serving an ageing cache.
  onCoinGeckoHealth((h) => {
    if (h.ok) {
      sources['coingecko'] = 'connected';
      delete sourceErrors['coingecko'];
    } else {
      sources['coingecko'] = 'error';
      sourceErrors['coingecko'] = h.reason ?? 'CoinGecko fetch failed.';
    }
  });

  // Wire macro/sentiment events to broadcast
  onCoinGeckoUpdate((q) => {
    if (ioInstance) ioInstance.emit('crypto_update', q);
  });
  onFREDUpdate((s) => {
    if (ioInstance) ioInstance.emit('macro_update', s);
  });
  // Same reason as Stooq below: a key FRED rejects would otherwise leave the
  // connector reporting `connected` with nothing behind it.
  onFREDHealth((h) => {
    if (h.ok) {
      // Contributing. A degraded cycle still says what is missing, through the
      // note channel rather than by claiming the whole source is down.
      sources['fred'] = 'connected';
      delete sourceErrors['fred'];
      if (h.degraded && h.reason) connectorNotes['fred'] = h.reason;
      else delete connectorNotes['fred'];
    } else {
      sources['fred'] = 'error';
      sourceErrors['fred'] = h.reason ?? 'FRED fetch failed.';
      delete connectorNotes['fred'];
    }
  });
  onRedditSentiment((s) => {
    if (ioInstance) ioInstance.emit('sentiment_update', s);
  });
  onNewsHeadline((h) => {
    if (ioInstance) ioInstance.emit('news_update', h);
  });
  onEventRegistryHeadline((h) => {
    if (ioInstance) ioInstance.emit('news_update', h);
  });
  onEventRegistryHealth((h) => {
    if (h.ok) {
      sources['eventregistry'] = 'connected';
      delete sourceErrors['eventregistry'];
    } else {
      sources['eventregistry'] = 'error';
      sourceErrors['eventregistry'] = h.reason ?? 'Event Registry fetch failed.';
    }
  });
  onCBOEData((d) => {
    if (ioInstance) ioInstance.emit('cboe_update', d);
  });

  // Start all 13 connectors (each handles missing env vars gracefully)
  Promise.allSettled([
    startConnector('flashalpha', startFlashAlpha),
    startConnector('marketdata', startMarketData),
    startConnector('schwab', startSchwab),
    startConnector('tastytrade', startTastytrade),
    startConnector('twelvedata', startTwelveData),
    startConnector('fmp', startFMP),
    startConnector('finnhub', startFinnhub),
    startConnector('eventregistry', startEventRegistry),
    startConnector('coingecko', startCoinGecko),
    startConnector('fred', startFRED),
    startConnector('reddit', startReddit),
    startConnector('newsapi', startNewsAPI),
    startConnector('cboe', startCBOE),
    startConnector('yahoo', startYahoo),
    startConnector('stooq', startStooq),
  ]).then(() => {
    // Count what is actually contributing. The old tally counted resolved
    // promises, which included every connector that had returned early for a
    // missing key — so it always read 13/13.
    const names = Object.keys(CONNECTOR_CREDENTIALS);
    const live = names.filter((n) => sources[n] === 'connected');
    const refused = names.filter((n) => sources[n] === 'refused');
    const keyless = names.filter(
      (n) => sources[n] !== 'refused' && missingCredentials(n).length > 0,
    );
    console.log(`[ingestion] ${live.length}/${names.length} connectors contributing`);
    if (keyless.length > 0) {
      console.log(`[ingestion] no credentials for: ${keyless.join(', ')}`);
    }
    // Reported separately from the missing-key list. A refused connector is not
    // waiting on a key and will not start when one is supplied.
    if (refused.length > 0) {
      console.log(
        `[ingestion] refused on data rights (not started): ${refused.join(', ')}`,
      );
      for (const n of refused) console.log(`[ingestion]   ${n}: ${sourceErrors[n]}`);
    }
  });

  // After the connectors, not before: the probe is an extra request per vendor
  // and the feed getting up is worth more than the diagnostic about it.
  startEntitlementProbes();

  // Drain bursts the engine is holding once the feed goes quiet — it finalizes
  // on the next trade's watermark, so an idle feed would sit on its last signal.
  setInterval(() => emitSignals(drainIdle()), 1_000).unref();

  // `repeatHits` is scored per *day*; reset it at the UTC session boundary so a
  // long-lived Render process doesn't drift every contract toward max repeats.
  let lastResetDay = new Date().getUTCDate();
  setInterval(() => {
    const day = new Date().getUTCDate();
    if (day !== lastResetDay) {
      lastResetDay = day;
      resetDaily();
      console.log('[ingestion] daily engine state reset');
    }
  }, 60_000).unref();

  // Dark pool simulation refresh every 5 minutes
  setInterval(addDarkPoolPrints, 300_000).unref();

  console.log('[ingestion] v3 started — flow-engine classification, seeded',
    flowEvents.length, 'signals, 13 connectors initializing');
}

// ─── Tradier WebSocket ───────────────────────────────────────────────────────

const TRADIER_TOKEN = process.env.TRADIER_TOKEN || '';
const TRADIER_WS = 'wss://ws.tradier.com/v1/markets/events';
const WATCHED_SYMBOLS = [
  'SPY', 'QQQ', 'SPX', 'NVDA', 'AAPL', 'TSLA', 'MSFT',
  'MSTR', 'MU', 'MRVL', 'AMD', 'META', 'AMZN', 'GOOG',
];

let tradierWs: WebSocket | null = null;

/**
 * What the profile probe concluded about `TRADIER_TOKEN`.
 *
 * `rejected` and `sandbox` are terminal: neither resolves without someone
 * changing the environment, so the reconnect loop stops on them instead of
 * hammering Tradier every 30s for the life of the process.
 */
type TradierTokenVerdict = 'unknown' | 'valid' | 'sandbox' | 'rejected';

let tradierTokenVerdict: TradierTokenVerdict = 'unknown';
/** Resolves once the probe has run, so `connect()` can gate its retry on it. */
let tradierProbe: Promise<void> = Promise.resolve();

/**
 * Ask Tradier who this token belongs to, on both hosts.
 *
 * A 401 from the streaming session endpoint is ambiguous on its own. The probe
 * splits it three ways using `/v1/user/profile`, which both hosts serve:
 *
 *   - production 200            → the token is good; the streaming call itself
 *                                 is what failed.
 *   - production 401, sandbox 200 → a sandbox token aimed at production. This is
 *                                 the single most common cause and it is not
 *                                 fixable from here.
 *   - both 401                  → wrong or revoked token.
 *
 * Note the earlier version of this concluded that a valid profile plus a
 * streaming 401 meant "no market-data entitlement". Tradier documents
 * entitlement failures as **403** and credential failures as 401, so that
 * inference pointed at the wrong problem — a 401 after a good profile means the
 * streaming request was malformed or the session expired, not that the account
 * needs an upgrade.
 *
 * The token is never logged or included in any recorded message.
 */
async function probeTradierProfile(host: string): Promise<number | null> {
  try {
    const res = await axios.get(`https://${host}/v1/user/profile`, {
      headers: { Authorization: `Bearer ${TRADIER_TOKEN}`, Accept: 'application/json' },
      timeout: 10_000,
    });
    return res.status;
  } catch (err: any) {
    return err?.response?.status ?? null;
  }
}

async function probeTradierToken(): Promise<void> {
  if (!TRADIER_TOKEN) {
    tradierTokenVerdict = 'rejected';
    sourceErrors['tradier_token'] = 'TRADIER_TOKEN is not set';
    return;
  }

  const prod = await probeTradierProfile('api.tradier.com');

  if (prod === 200) {
    tradierTokenVerdict = 'valid';
    sourceErrors['tradier_token'] =
      'profile HTTP 200 — token is valid for api.tradier.com. A streaming 401 ' +
      'therefore means the session request itself was rejected (Tradier reports ' +
      'missing entitlements as 403, not 401).';
    return;
  }

  if (prod === 401) {
    const sandbox = await probeTradierProfile('sandbox.tradier.com');
    if (sandbox === 200) {
      tradierTokenVerdict = 'sandbox';
      sourceErrors['tradier_token'] =
        'profile HTTP 401 on api.tradier.com but HTTP 200 on sandbox.tradier.com — ' +
        'this is a SANDBOX token. Sandbox tokens are only valid against ' +
        'sandbox.tradier.com and cannot stream production market data. Issue a ' +
        'production access token from the Tradier dashboard and set TRADIER_TOKEN to it.';
    } else {
      tradierTokenVerdict = 'rejected';
      sourceErrors['tradier_token'] =
        'profile HTTP 401 on both api.tradier.com and sandbox.tradier.com — ' +
        'the token is wrong or has been revoked. Reissue it from the Tradier dashboard.';
    }
    return;
  }

  tradierTokenVerdict = 'unknown';
  sourceErrors['tradier_token'] = prod === null
    ? 'profile probe could not reach api.tradier.com (network or timeout) — token status unknown'
    : `profile HTTP ${prod} on api.tradier.com — unexpected; token status unknown`;
}

function startTradierIngestion(): void {
  tradierProbe = probeTradierToken();

  if (!TRADIER_TOKEN) {
    console.log('[tradier] No token — skipping WebSocket, using simulation');
    markNoCredentials('tradier', ['TRADIER_TOKEN']);
    startSimulationFeed();
    return;
  }

  const BASE_RETRY_MS = 30_000;
  const MAX_RETRY_MS = 10 * 60_000;
  let retryDelayMs = BASE_RETRY_MS;

  // Tradier's stream will not accept a made-up session id. One has to be minted
  // per connection from the REST API and is short-lived, so this runs on every
  // (re)connect rather than being cached.
  async function mintSessionId(): Promise<{ sessionid: string; url: string }> {
    const res = await axios.post(
      'https://api.tradier.com/v1/markets/events/session',
      null,
      {
        headers: {
          Authorization: `Bearer ${TRADIER_TOKEN}`,
          Accept: 'application/json',
        },
        timeout: 10_000,
      }
    );
    const sessionid = res.data?.stream?.sessionid;
    if (!sessionid) throw new Error('no sessionid in /markets/events/session response');
    // Tradier returns the socket URL alongside the id; prefer it over the
    // hardcoded constant so a vendor-side move does not silently break this.
    return { sessionid, url: res.data?.stream?.url || TRADIER_WS };
  }

  async function connect() {
    try {
      const { sessionid, url } = await mintSessionId();

      // The Authorization header is not documented as required on the socket
      // handshake (the sessionid in the first frame is the credential), but it
      // is kept: the session mint fails first today, so this path has never
      // been exercised and there is no way to detect a regression from removing it.
      tradierWs = new WebSocket(url, {
        headers: { Authorization: `Bearer ${TRADIER_TOKEN}` },
      });

      tradierWs.on('open', () => {
        sources['tradier'] = 'connected';
        delete sourceErrors['tradier'];
        retryDelayMs = BASE_RETRY_MS; // a real connection clears the backoff
        const msg = JSON.stringify({
          symbols: WATCHED_SYMBOLS,
          sessionid,
          linebreak: true,
          filter: ['quote', 'trade', 'timesale'],
        });
        tradierWs?.send(msg);
        console.log('[tradier] WebSocket connected');
      });

      tradierWs.on('message', (raw: Buffer) => {
        try {
          const data = JSON.parse(raw.toString());
          if (data.type === 'timesale' || data.type === 'trade') {
            processMarketTick(data, 'tradier');
          }
        } catch {
          noteUnparsedFrame('tradier');
        }
      });

      tradierWs.on('error', (err) => {
        sources['tradier'] = 'error';
        sourceErrors['tradier'] = `ws: ${err.message}`;
        console.error('[tradier] WS error:', err.message);
      });

      tradierWs.on('close', () => {
        sources['tradier'] = 'error';
        console.log('[tradier] WS closed — reconnecting in 5s');
        setTimeout(() => { void connect(); }, 5000);
      });
    } catch (err: any) {
      const status = err.response?.status;
      const detail = describeHttpError(err);
      console.error('[tradier] connect failed:', detail);
      sources['tradier'] = 'error';
      sourceErrors['tradier'] = detail;
      // Keep the feed alive with clearly-flagged synthetic prints either way.
      startSimulationFeed();

      // Wait for the probe before deciding whether retrying is worth anything.
      await tradierProbe;

      // A 401 on the session mint with a token the probe has already proven bad
      // is not a transient failure — no number of retries fixes a sandbox or
      // revoked token, and the old unconditional 30s loop meant a dead token
      // produced two REST calls a minute forever. Stop, and leave the reason in
      // `sourceErrors` where /api/health will show it.
      if (status === 401 && (tradierTokenVerdict === 'sandbox' || tradierTokenVerdict === 'rejected')) {
        sourceErrors['tradier'] =
          `${detail} — retries stopped, see tradier_token for the reason. ` +
          `Restart the service after setting a valid TRADIER_TOKEN.`;
        console.error('[tradier] token is not usable; giving up on reconnect');
        return;
      }

      // Anything else may be transient (Tradier outage, network, rate limit).
      // Back off geometrically instead of a fixed 30s so an extended outage does
      // not sustain a fixed request rate against a service that is already down.
      const wait = retryDelayMs;
      retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_MS);
      console.log(`[tradier] retrying in ${Math.round(wait / 1000)}s`);
      setTimeout(() => { void connect(); }, wait);
    }
  }

  void connect();
}

function processMarketTick(data: any, source: string): void {
  if (!data.symbol || !data.price || !data.size) return;

  const match = String(data.symbol).match(/^([A-Z]+)(\d{6})([CP])(\d+)$/);
  if (!match) return; // equity print, not an option

  const [, sym, dateStr, cpFlag, strikeStr] = match;
  if (!sym || !dateStr || !cpFlag || !strikeStr) return;

  const expiry = `20${dateStr.slice(0, 2)}-${dateStr.slice(2, 4)}-${dateStr.slice(4, 6)}`;
  const price = parseFloat(data.price);
  const size = parseInt(data.size, 10);
  if (!(price > 0) || !(size > 0)) return;

  emitSignals(ingestPrint({
    id: `${source}-${data.seq ?? `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`}`,
    ts: data.date ? Number(data.date) : Date.now(),
    symbol: sym,
    expiry,
    strike: parseInt(strikeStr, 10) / 1000,
    right: cpFlag as 'C' | 'P',
    price,
    size,
    exchange: data.exch ?? 'UNKNOWN',
    // Quoted NBBO when the feed carries it; without it the engine correctly
    // refuses to infer a side rather than guessing one.
    bid: data.bid !== undefined ? parseFloat(data.bid) : undefined,
    ask: data.ask !== undefined ? parseFloat(data.ask) : undefined,
    source,
  }));
}

// ─── Polygon REST polling ────────────────────────────────────────────────────

const POLYGON_KEY = process.env.POLYGON_API_KEY || '';

/**
 * How many NBBO lookups one poll cycle may spend.
 *
 * The trades poll returns up to 25 prints and each distinct contract costs one
 * additional request, so an unbounded version would multiply this connector's
 * request rate by 25 against a vendor whose free tier allows five calls a
 * minute. Capped and deduped: the busiest contracts in a cycle get a side, the
 * tail stays AMBIGUOUS, and nothing is invented for the ones that miss out.
 */
const POLYGON_QUOTE_BUDGET = 8;

/** Polygon's contract ticker, e.g. `O:SPY260918C00500000`. Exported for tests. */
export function polygonOptionTicker(
  underlying: string, expiry: string, right: 'C' | 'P', strike: number,
): string {
  const yymmdd = expiry.split('-').join('').slice(2);
  const strike8 = String(Math.round(strike * 1000)).padStart(8, '0');
  return `O:${underlying.toUpperCase()}${yymmdd}${right}${strike8}`;
}

/** Why the NBBO half is not contributing, when it is not. Reported separately. */
let polygonQuoteNote: string | undefined;

/**
 * Frames a streaming source sent that this process could not parse.
 *
 * Both WebSocket handlers ended `} catch {}`. A frame that failed to parse was
 * dropped with no counter, no log and no health signal — so a vendor changing
 * its envelope, or a partial frame, produced a source that was `connected`,
 * receiving bytes, and emitting nothing, with `/api/health` reporting it as
 * working. That is the Stooq failure without even a zero to show for it: the
 * three times this repo has fixed "a source that is down must not present
 * itself as data", the source at least produced something.
 */
const unparsedFrames: Record<string, number> = {};

/**
 * "Connected, and here is what is missing."
 *
 * `sources` has three states and none of them fits a source that is working
 * and incomplete. FRED reporting `error` because one of ten series was
 * discontinued upstream sends an operator hunting a key problem that does not
 * exist — the mirror image of reporting a dead source as `connected`, and just
 * as misleading. This is the same channel `polygonQuoteNote` uses for a trades
 * feed whose NBBO lookups are refused.
 */
const connectorNotes: Record<string, string> = {};

function noteUnparsedFrame(source: string): void {
  unparsedFrames[source] = (unparsedFrames[source] ?? 0) + 1;
  const n = unparsedFrames[source]!;
  // Log on the first and then sparsely: a vendor that changes its envelope
  // produces one per frame, and a log line per frame is its own outage.
  if (n === 1 || n % 500 === 0) {
    console.warn(`[${source}] ${n} stream frame(s) could not be parsed`);
  }
}

/**
 * The NBBO in force at the moment of a trade, from Polygon.
 *
 * `timestamp.lte` is the whole design. Asking for the *current* quote would be
 * useless and dangerous at once: useless because `nbboMaxAgeMs` is 2 seconds
 * and a quote fetched after a 10-second poll cycle is stale by definition, so
 * every side would come out AMBIGUOUS anyway; dangerous because a quote from
 * after the trade may already reflect that trade, and reading a direction off
 * it is look-ahead. Bounding the query at or before the trade's own nanosecond
 * timestamp makes the answer historically correct by construction, and leaves
 * the staleness judgement where it belongs — with the engine.
 *
 * Returns undefined rather than throwing: a missing quote is a normal outcome
 * that costs the print its direction, not an ingestion failure.
 */
export async function fetchPolygonNbbo(
  ticker: string, tradeTsNs: number,
): Promise<{ bid: number; ask: number; ts: number } | undefined> {
  const { data } = await axios.get(
    `https://api.polygon.io/v3/quotes/${encodeURIComponent(ticker)}`,
    {
      timeout: 5000,
      headers: { Authorization: `Bearer ${POLYGON_KEY}` },
      params: { 'timestamp.lte': String(tradeTsNs), order: 'desc', limit: 1 },
    },
  );

  const q = data?.results?.[0];
  if (!q) return undefined;

  const bid = Number(q.bid_price);
  const ask = Number(q.ask_price);
  const ns = Number(q.sip_timestamp);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || !Number.isFinite(ns)) return undefined;
  // A zero or crossed book is not a quote. The engine drops these too, but
  // sending them would still overwrite a good prior quote in the book.
  if (!(ask > 0) || ask < bid || bid < 0) return undefined;

  return { bid, ask, ts: Math.round(ns / 1_000_000) };
}

function startPolygonIngestion(): void {
  if (!POLYGON_KEY) {
    markNoCredentials('polygon', ['POLYGON_API_KEY']);
    return;
  }

  // Deliberately not marked 'connected' here. The first poll runs immediately
  // and reports what actually happened; claiming a connection before one has
  // succeeded is how a dead key showed as healthy.

  async function poll() {
    try {
      // Key goes in the Authorization header, not the query string: the URL
      // shows up in vendor error bodies and proxy logs, and this error path
      // now surfaces those bodies through the public /api/health route.
      const { data } = await axios.get(
        'https://api.polygon.io/v3/trades/options?limit=25',
        {
          timeout: 5000,
          headers: { Authorization: `Bearer ${POLYGON_KEY}` },
        }
      );

      // Recovered: a poll got through, so drop any stale failure reason. Without
      // this the source stayed 'error' forever after one bad poll.
      sources['polygon'] = 'connected';
      delete sourceErrors['polygon'];
      polygonQuoteNote = undefined;

      if (data?.results) {
        // One NBBO lookup per distinct contract per cycle, up to the budget.
        // Two prints on the same contract in one batch share a quote request;
        // the one asked for is the earliest trade's, so a later print in the
        // same contract sees a quote at or before its own timestamp too.
        const quotes = new Map<string, { bid: number; ask: number; ts: number }>();
        let spent = 0;
        let quoteFailure: string | undefined;

        for (const t of data.results) {
          if (spent >= POLYGON_QUOTE_BUDGET) break;
          const d = t.details ?? {};
          if (!t.sip_timestamp || !d.expiration_date || !d.strike_price) continue;

          const ticker = polygonOptionTicker(
            t.underlying_asset?.ticker ?? 'UNK',
            d.expiration_date,
            d.contract_type === 'call' ? 'C' : 'P',
            d.strike_price,
          );
          if (quotes.has(ticker)) continue;

          spent++;
          try {
            const nbbo = await fetchPolygonNbbo(ticker, Number(t.sip_timestamp));
            if (nbbo) quotes.set(ticker, nbbo);
          } catch (err: any) {
            // Reported, not swallowed — but on its own line. The trades feed is
            // working (we are inside its success path), and flipping the whole
            // source to `error` because quotes are not entitled would say the
            // feed is down when it is delivering prints.
            quoteFailure = describeHttpError(err);
            break;
          }
        }

        polygonQuoteNote = quoteFailure
          ? `Trades are flowing; NBBO lookups are failing, so every Polygon signal ` +
            `stays AMBIGUOUS: ${quoteFailure}`
          : undefined;

        for (const t of data.results) {
          if (!t.sip_timestamp || !t.price || !t.size) continue;
          const details = t.details ?? {};
          if (!details.expiration_date) continue;

          // Nine lines below, this same possibly-absent field was written as
          // `strike: details.strike_price ?? 0`. The NBBO lookup knew it could
          // be missing; the print did not.
          if (typeof details.strike_price !== 'number' || !(details.strike_price > 0)) continue;

          const nbbo = details.strike_price !== undefined
            ? quotes.get(polygonOptionTicker(
                t.underlying_asset?.ticker ?? 'UNK',
                details.expiration_date,
                details.contract_type === 'call' ? 'C' : 'P',
                details.strike_price,
              ))
            : undefined;

          emitSignals(ingestPrint({
            id: `poly-${t.sequence_number ?? `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`}`,
            ts: Math.round(t.sip_timestamp / 1_000_000),
            symbol: t.underlying_asset?.ticker ?? 'UNK',
            expiry: details.expiration_date,
            strike: details.strike_price,
            right: details.contract_type === 'call' ? 'C' : 'P',
            price: t.price,
            size: t.size,
            exchange: String(t.exchange ?? 'UNKNOWN'),
            conditions: Array.isArray(t.conditions) ? t.conditions : [],
            // Polygon condition 4 marks an Intermarket Sweep Order.
            iso: Array.isArray(t.conditions) ? t.conditions.includes(4) : undefined,
            source: 'polygon',
            // The trades endpoint carries no quote, so the NBBO is fetched
            // separately, bounded at or before this trade's own timestamp.
            // `quoteTs` is the quote's real time, not this trade's: the engine
            // decides whether it is fresh enough to give a side, and a quote it
            // judges stale leaves the print AMBIGUOUS — which is the correct
            // outcome, not a failure. Pre-v3 this path fabricated a ±1%
            // bid/ask and inferred a side from that.
            bid: nbbo?.bid,
            ask: nbbo?.ask,
            quoteTs: nbbo?.ts,
          }));
        }
      }
    } catch (err: any) {
      // Every failure is reported, and the vendor's own words are what get
      // reported. This used to swallow anything that was not a 403 and, for a
      // 403, substitute a guess ("not included in this Polygon plan") for
      // Polygon's actual response — which made the health route confidently
      // wrong about why the feed was down. Polygon names the reason in the
      // body (NOT_AUTHORIZED vs. an entitlement message); that is the thing
      // worth reading, so pass it through rather than editorializing.
      sources['polygon'] = 'error';
      sourceErrors['polygon'] = describeHttpError(err);
    }
  }

  setInterval(poll, 10_000).unref();
  poll();
}

/**
 * The spot board, from every source that may show one.
 *
 * Twelve Data wins where both have a symbol: it is the source `getSpotPrice`
 * grades against, so a reader comparing the tape to the track record sees the
 * same number. Finnhub fills the symbols Twelve Data has no quote for —
 * keyless, rate-limited, or simply not covering it.
 *
 * Each quote carries its own `source` and `timestamp`, so the tape's `AS OF`
 * staleness marking and the provenance stay per-symbol rather than per-board.
 */
export function getSpotQuotes(): Map<string, SpotQuote> {
  const merged = new Map(getFinnhubSpotQuotes());
  for (const [symbol, quote] of getTwelveDataSpotQuotes()) merged.set(symbol, quote);
  return merged;
}

// ─── Finnhub ─────────────────────────────────────────────────────────────────
//
// A spot-quote source for DISPLAY only. See `connectors/finnhub.ts` for the
// quoted term that keeps it out of the grader, and `rights.ts` for the
// registry entry that enforces it.
//
// The previous connector of this name streamed EQUITY trades and handed each
// price to `simulatePrints`, putting manufactured OPTION prints on the tape of
// a deployment that had paid for a real feed. It was deleted; this one
// publishes what Finnhub actually sends.

// ─── Simulation feed (fallback) ──────────────────────────────────────────────

let simInterval: ReturnType<typeof setInterval> | null = null;

const SIM_SPOTS: Record<string, number> = {
  SPY: 580, QQQ: 480, NVDA: 140, AAPL: 220, TSLA: 250, MSFT: 410, MSTR: 380, AMD: 165,
};

function startSimulationFeed(): void {
  if (simInterval) return;
  sources['simulation'] = 'connected';

  simInterval = setInterval(() => {
    const symbols = Object.keys(SIM_SPOTS);
    const symbol = symbols[Math.floor(Math.random() * symbols.length)]!;
    const spot = SIM_SPOTS[symbol]! * (1 + (Math.random() - 0.5) * 0.002);
    SIM_SPOTS[symbol] = spot;
    emitSignals(simulatePrints(symbol, spot, Date.now()).flatMap(ingestPrint));
  }, 3000).unref();

  console.log('[ingestion] Simulation feed running');
}

/**
 * Build one simulated order as the prints that would compose it.
 *
 * The engine is a filter, not a passthrough — it only emits above
 * `minSignalPremium`, and only calls a cluster a SWEEP when it lands on
 * several venues. So the simulation has to produce order *shapes* (multi-venue
 * sweeps, spreads, institutional size) rather than isolated small prints, or
 * the feed would sit empty in demo mode.
 */
function simulatePrints(symbol: string, spot: number, ts: number): RawPrint[] {
  const right: 'C' | 'P' = Math.random() > 0.45 ? 'C' : 'P';
  const dte = [1, 2, 7, 14, 30, 60][Math.floor(Math.random() * 6)]!;
  const expiry = isoDatePlusDays(ts, dte);

  const strike = Math.round((spot * (1 + (Math.random() - 0.5) * 0.06)) / 5) * 5;
  const price = parseFloat((0.5 + Math.random() * 7.5).toFixed(2));

  // Log-uniform premium, roughly $30k–$2M, then solve for contract count.
  const premium = Math.exp(Math.log(30_000) + Math.random() * Math.log(2_000_000 / 30_000));
  const size = Math.max(1, Math.round(premium / (price * 100)));

  const spread = Math.max(0.02, price * 0.02);
  const bid = parseFloat((price - spread / 2).toFixed(2));
  const ask = parseFloat((bid + spread).toFixed(2));

  // Where the order fills decides the inferred side — 20% land at mid, where
  // the engine reports AMBIGUOUS rather than inventing a direction.
  const roll = Math.random();
  const fill = roll < 0.45 ? ask
    : roll < 0.65 ? bid
    : roll < 0.80 ? parseFloat((bid + spread * 0.75).toFixed(2))
    : parseFloat(((bid + ask) / 2).toFixed(2));

  // A simulated sweep is simulated as what a sweep actually is: several
  // executions, at several venues, close together in time. It used to be one
  // record carrying a venue *list*, which the adapter then split into one
  // fabricated print per venue — so the simulation was relying on the
  // fabrication to look like a sweep, and it was the only producer of the
  // multi-venue input that triggered it. Generating the prints here is honest
  // (this code really is inventing N executions, and says so via `synthetic`)
  // and it keeps the adapter free to treat a declared venue list as evidence.
  const venues = Math.random() < 0.35
    ? ['CBOE', 'PHLX', 'AMEX', 'ISE'].slice(0, 2 + Math.floor(Math.random() * 3))
    : ['CBOE'];

  const oi = Math.floor(size * (0.3 + Math.random() * 4));
  const base: RawPrint = {
    id: `sim-${ts}-${Math.random().toString(36).slice(2, 7)}`,
    ts,
    symbol,
    expiry,
    strike,
    right,
    price: fill,
    size,
    exchange: venues[0],
    bid,
    ask,
    openInterest: oi,
    dayVolume: Math.floor(oi * Math.random()),
    underlyingPrice: parseFloat(spot.toFixed(2)),
    iv: parseFloat((0.2 + Math.random() * 0.8).toFixed(3)),
    iso: venues.length > 1 && Math.random() < 0.5,
    source: 'simulation',
    synthetic: true,
  };

  // One execution per venue, each with its own id, its own size and its own
  // instant — a real multi-venue sweep is a burst of separate prints, and the
  // engine clusters them because they are separate.
  const legs: RawPrint[] = venues.map((venue, i) => {
    const perVenue = Math.max(1, Math.floor(size / venues.length));
    return {
      ...base,
      id: `${base.id}-v${i}`,
      // Milliseconds apart, inside the engine's sweep window, which is what
      // makes them one burst rather than unrelated trades.
      ts: ts + i * 3,
      size: i === venues.length - 1
        ? size - perVenue * (venues.length - 1)
        : perVenue,
      exchange: venue,
    };
  });

  // 12% of orders are a two-leg vertical: same right and expiry, second strike,
  // both legs printing inside the engine's multi-leg window.
  if (Math.random() < 0.12) {
    const farStrike = strike + (right === 'C' ? 10 : -10);
    const farPrice = parseFloat(Math.max(0.05, fill * 0.45).toFixed(2));
    return [...legs, {
      ...base,
      id: `${base.id}-leg2`,
      ts: ts + venues.length * 3 + 5,
      strike: farStrike,
      price: farPrice,
      bid: parseFloat(Math.max(0.01, farPrice - 0.05).toFixed(2)),
      ask: parseFloat((farPrice + 0.05).toFixed(2)),
      exchange: 'CBOE',
      iso: false,
    }];
  }

  return legs;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isoDatePlusDays(fromTs: number, days: number): string {
  const d = new Date(fromTs);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0]!;
}

// ─── Broadcast ──────────────────────────────────────────────────────────────

const BATCH_WINDOW_MS = 100;
const broadcastQueue: FlowEvent[] = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Store + broadcast finalized signals.
 *
 * One delivery path per client: a single global `flow_batch`. (Pre-v3 the
 * pipeline emitted `flow_update` globally *and* to the symbol room, so anyone
 * subscribed to a ticker received every one of its events twice.) Symbol rooms
 * remain joinable for future targeted streams; the feed itself is filtered
 * client-side.
 */
// ─── Durable signal history ─────────────────────────────────────────────────

let grader: SignalGrader | undefined;

/**
 * How many unfinished signals one startup recovery will resume.
 *
 * Bounded because recovery runs at boot and issues one `listOutcomes` read per
 * signal; an unbounded scan of a long history would make startup a function of
 * how much history exists. Anything beyond the bound stays unresumed and is
 * reported rather than silently dropped.
 */
const RECOVERY_LIMIT = 500;

let lastRecovery: RecoveryReport | undefined;

/**
 * Subscribe the recorder and grader to the engine's output.
 *
 * This is the difference between a terminal that shows flow and a system that
 * remembers it. Without it, every signal this process classifies is discarded
 * within 500 events, the ring buffer dies with the process, and no track
 * record can ever accumulate no matter how long the service runs.
 */
function startSignalHistory(): void {
  const { store, recorder } = initPersistence();

  // Underlying marks come from Twelve Data's spot cache, and from nowhere else.
  //
  // Two sources are refused here for two different reasons, and both refusals
  // would be undone by "just add a fallback":
  //
  //   - Yahoo's terms prohibit automated access for any purpose, so it is
  //     PROHIBITED for DISPLAY and its connector never starts.
  //   - Finnhub fills the *display* board (see `getSpotQuotes`), but its terms
  //     forbid sharing "data or derived results from the data" with any third
  //     party without written approval. A graded outcome is a derived result
  //     and `/api/track-record` publishes it, so `FINNHUB_QUOTES` is
  //     PROHIBITED for PERSIST and must not be read here.
  //
  // Twelve Data itself is `UNVERIFIED` for PERSIST — its retention is capped
  // at "duration permitted by subscription", which this deployment has not
  // established. That is reported by `tools/collection/doctor.ts` rather than
  // enforced, because the connector gate deliberately refuses PROHIBITED only
  // and widening it would collapse the DISPLAY/PERSIST distinction the
  // registry exists to draw.
  // The mark comes from a ranked registry now, not one hard-wired vendor, and
  // every outcome records which source priced it. See ingestion/markSources.ts
  // for why that registry is currently one entry long.
  grader = new SignalGrader(store, (underlying) => resolveMark(underlying));

  // Resume checkpoints the last process did not live to observe.
  //
  // The grader's schedule is process memory, so before this every restart
  // silently abandoned every pending M15/H1/D1: the signal row survived in
  // `signal_history`, no outcome was ever written for it, and nothing looked
  // again. On a host that sleeps after 15 minutes of inactivity — which is the
  // documented deployment target, and 15 minutes is also the shortest horizon
  // — that is close to every checkpoint this system has ever scheduled.
  //
  // Fire-and-forget for the same reason recording is: recovery must never be
  // able to stop the process that is collecting. A failure is counted in the
  // grader's stats and surfaced on /api/health.
  void grader.recover(RECOVERY_LIMIT, (src) => markRightsClass(src))
    .then((r) => {
      lastRecovery = r;
      if (r.examined === 0) return;
      console.log(
        `[history] recovery: examined=${r.examined} resumed=${r.resumed} ` +
        `complete=${r.alreadyComplete} withEntryMark=${r.withEntryMark} failed=${r.failed}`,
      );
      // A resumed signal with no recovered entry mark can only grade UNGRADED.
      // Said out loud because it is the visible cost of the restart, and the
      // alternative — taking a fresh mark now — would hide it behind a number.
      const noMark = r.resumed - r.withEntryMark;
      if (noMark > 0) {
        console.warn(
          `[history] ${noMark} resumed signal(s) have no observed entry mark and ` +
          `will grade UNGRADED: the process was not running when their entry ` +
          `price should have been taken.`,
        );
      }
    })
    .catch(() => { /* counted in grader stats */ });

  onSignal((sig, origin) => {
    // Fire-and-forget: recording must never add latency to the live tape or
    // take it down on a database hiccup. Failures are counted in the
    // recorder's stats and surfaced on /api/health.
    void recorder.record(sig, origin).then(async (res) => {
      if (res.status !== 'RECORDED' || !res.signalKey) return;
      const rec: SignalRecord | undefined = await store.getSignal(res.signalKey);
      if (rec) grader?.register(rec);
    }).catch(() => { /* counted in recorder stats */ });
  });

  // Grade due checkpoints once a minute. The shortest horizon is 15 minutes,
  // so a 60s tick is well inside the lateness tolerance.
  //
  // The same tick records collection coverage. `collection_gaps` had a table,
  // a type, a constraint set and two store implementations, and no caller —
  // so the apparatus built to stop a window of missing data being read as a
  // quiet tape had never written a row. See persistence/coverage.ts.
  coverage = new CoverageRecorder(`run${Date.now()}`);

  // Claim the window the PREVIOUS process could not.
  //
  // A process that sleeps cannot close its own gap — it is gone — so its open
  // row freezes at the last extent and its `endedAt` becomes a positive claim
  // that collection resumed then. It did not. Measured on the live project:
  // 9 gap rows totalling 126 minutes across a 4,160-minute span, every row the
  // same ~14-minute length, with a 33-hour silence in `signal_history` carrying
  // no gap row at all. The apparatus built to stop a flattering hit rate was
  // under-reporting non-collecting time by ~97%.
  //
  // Only the next boot can see that hole, so the next boot attributes it.
  // Fire-and-forget, like every other write on this path: a coverage row must
  // never be able to take down the process that is collecting.
  void lastRecordedActivity(store)
    .then((lastMs) => {
      const missed = recoverMissedWindow(lastMs, Date.now(), `run${Date.now()}`);
      if (!missed) return;
      lastCoverageGap = missed;
      console.warn(
        `[coverage] claiming unobserved window ` +
        `${new Date(missed.startedAt).toISOString()} -> ` +
        `${new Date(missed.endedAt).toISOString()} ` +
        `(${Math.round((missed.endedAt - missed.startedAt) / 60_000)} min) — the ` +
        `previous process stopped without closing it`,
      );
      return store.recordGap(missed);
    })
    .catch((err) => {
      // Never block collection on the coverage record — but never lose the
      // failure either.
      console.warn(
        `[coverage] missed-window claim failed: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    });

  setInterval(() => {
    void grader?.tick().catch(() => { /* counted in grader stats */ });

    const gap = coverage?.tick(sampleCoverage(), Date.now());
    if (gap) {
      // Fire-and-forget for the same reason recording is: a coverage row must
      // never be able to take down the process that is collecting.
      void store.recordGap(gap).catch(() => { /* nothing else to do here */ });
      lastCoverageGap = gap;
    }
  }, 60_000).unref();

  const p = describePersistence();
  console.log(`[history] store=${p.store} durable=${p.durable} mode=${p.businessMode}`);
  if (!p.durable) console.warn(`[history] ${p.reason}`);
}

/**
 * The most recent instant this deployment has evidence for.
 *
 * The later of the newest recorded gap's end and the newest signal's decision
 * time. Both are needed: a deployment that recorded gaps and no signals has
 * only the former, one that recorded signals and never hit a gap has only the
 * latter, and taking the later of the two is what stops a fresh gap from
 * overlapping a window that was demonstrably productive.
 *
 * `null` when the deployment can show nothing at all — a first-ever boot has
 * no window behind it.
 */
async function lastRecordedActivity(store: SignalStore): Promise<number | null> {
  let newest: number | null = null;
  const note = (ms: number | undefined) => {
    if (ms !== undefined && Number.isFinite(ms) && ms > 0) {
      newest = newest === null ? ms : Math.max(newest, ms);
    }
  };

  // Neither read is allowed to swallow its failure. A store that cannot answer
  // means coverage recovery does not run, and a boot that silently skipped it
  // looks identical to a boot with nothing to claim — which is the class of
  // defect this whole module exists to remove, so it is said out loud.
  try {
    // A wide window on purpose: the question is "when did this deployment last
    // do anything", and a narrow one would answer "never" after a long sleep —
    // which is the exact under-reporting being fixed.
    const gaps = await store.listGaps(0);
    for (const g of gaps) note(g.endedAt);
  } catch (err) {
    console.warn(
      `[coverage] could not read prior gaps; the missed window may be ` +
      `under-claimed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    const recent = await store.listUngraded(1);
    for (const r of recent) note(r.decisionAt);
  } catch (err) {
    console.warn(
      `[coverage] could not read prior signals; the missed window may be ` +
      `under-claimed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return newest;
}

let coverage: CoverageRecorder | undefined;
let lastCoverageGap: CollectionGap | null = null;

/**
 * What the coverage recorder needs to know, read off the live board.
 *
 * "Collecting" is deliberately **not** "the process is up". A process with
 * every connector disabled is running perfectly and observing nothing, and
 * that is precisely the window this table exists to mark. It is also not "any
 * source is connected": CBOE and FRED being up says nothing about whether an
 * options print could have been recorded, so the question is asked of the
 * sources that could actually be persisted.
 */
function sampleCoverage(): CoverageSample {
  const recordable = RECORDABLE_FOR_COVERAGE.filter((s) => sources[s] === 'connected');
  const stats = describePersistence().recorder;
  // Real signals only. The simulator runs whenever no live feed does, so
  // counting synthetic rows here would report a dead deployment as productive
  // — which is the exact shape of the `78 synthetic, 0 real` track record.
  const recorded = (stats?.recorded ?? 0) - (stats?.syntheticRecorded ?? 0);

  if (recordable.length > 0) {
    return { collecting: true, reason: `${recordable.join(', ')} connected`, recorded };
  }
  // Name the states rather than just the absence, so a reason read months
  // later says whether this was an outage, a missing key or a rights refusal.
  const detail = RECORDABLE_FOR_COVERAGE
    .map((s) => `${s}=${sources[s] ?? 'unstarted'}`)
    .join(', ');
  return {
    collecting: false,
    reason: `no recordable source connected (${detail})`,
    recorded,
  };
}

/**
 * The sources whose prints could reach the durable history.
 *
 * Same list as the doctor's `RECORDABLE_SOURCES`, and it has to stay that way
 * — a source that can be recorded but is not counted here makes a productive
 * window look like an outage. `coverage.test.ts` holds the two together.
 */
const RECORDABLE_FOR_COVERAGE = [
  'tradier', 'polygon', 'marketdata', 'schwab', 'tastytrade',
] as const;

/**
 * Rendered into /api/health so the collection state is visible, not assumed.
 *
 * /api/health is served UNAUTHENTICATED, so every string here is public. The
 * recorder's and grader's `lastError` are raw messages from the Supabase
 * client and can carry the project URL or other connection detail, so they are
 * stripped here and served only from /api/track-record, which sits behind
 * auth. Counters stay — they are the operationally useful part and they leak
 * nothing. (Same reasoning as `sourceErrors`/`describeHttpError` elsewhere in
 * this file.)
 */
export function getSignalHistoryStatus() {
  const p = describePersistence();
  const graderStats = grader?.getStats();

  /** Strip `lastError`, keep every counter. */
  const scrub = <T extends { lastError?: string }>(s: T | null | undefined) => {
    if (!s) return null;
    const { lastError: _dropped, ...counters } = s;
    return counters;
  };

  return {
    ...p,
    recorder: scrub(p.recorder),
    grader: scrub(graderStats),
    /**
     * What the last startup recovery resumed, or `null` before it has run.
     *
     * Published because the interesting number is `resumed - withEntryMark`:
     * signals whose checkpoints were rescheduled but whose entry price was
     * never observed, and which can therefore only ever grade UNGRADED. That
     * is the measurable cost of a restart, and leaving it out of the health
     * payload would put this fix in the same position as the apparatus it
     * repairs — correct, and invisible.
     */
    recovery: lastRecovery ?? null,
    // Flags that something failed without saying what. The detail is one
    // authenticated call away, at /api/track-record.
    errorsSuppressed: Boolean(p.recorder?.lastError || graderStats?.lastError),
    rights: rightsSnapshot(),
    /**
     * Whether this process is currently able to collect, and the gap it is
     * accumulating if not. A reader looking at "0 real" can otherwise not tell
     * an idle tape from a process that has been observing nothing for a week.
     */
    coverage: {
      ...sampleCoverage(),
      openGap: coverage?.getOpenGap() ?? null,
      lastGap: lastCoverageGap,
    },
  };
}

function emitSignals(events: FlowEvent[]): void {
  if (events.length === 0) return;

  for (const event of events) flowEvents.unshift(event);
  if (flowEvents.length > MAX_FLOW_EVENTS) {
    flowEvents = flowEvents.slice(0, MAX_FLOW_EVENTS);
  }

  if (!ioInstance) return;
  broadcastQueue.push(...events);
  if (batchTimer) return;
  batchTimer = setTimeout(() => {
    if (broadcastQueue.length > 0) ioInstance.emit('flow_batch', [...broadcastQueue]);
    broadcastQueue.length = 0;
    batchTimer = null;
  }, BATCH_WINDOW_MS);
}

/** Convert the chain-snapshot connectors' camelCase events into RawPrints. */
function legacyEventToPrint(e: LegacyFlowEvent, source: string): RawPrint | null {
  if (!e.symbol || !e.expiration || !(e.size > 0)) return null;
  const price = e.size > 0 ? e.premium / (e.size * 100) : 0;
  if (!(price > 0)) return null;
  return {
    id: e.id,
    ts: Date.parse(e.timestamp) || Date.now(),
    symbol: e.symbol,
    expiry: e.expiration,
    strike: e.strike,
    right: e.callPut,
    price,
    size: e.size,
    exchange: e.exchange ?? 'CHAIN',
    bid: e.bid,
    ask: e.ask,
    iv: e.iv,
    delta: e.delta,
    source,
    // These connectors poll option *chains* and synthesize a print from the
    // day's aggregate volume — not real tape. Flagged so the UI can say so.
    synthetic: true,
    // And none of the four report when `last` traded. `e.timestamp` is the
    // moment this process read the chain, written by all four as
    // `new Date().toISOString()`, so using it for both the trade and the quote
    // claims a simultaneity that is known to be false — see `RawPrint`. This
    // is the single seam all four pass through, which is why the statement
    // belongs here rather than four times over.
    tradeTimeUnknown: true,
  };
}

function addDarkPoolPrints(): void {
  const SYMBOLS = ['SPY', 'QQQ', 'NVDA', 'AAPL', 'TSLA', 'MSFT', 'AMD'];
  const spots: Record<string, number> = {
    SPY: 580, QQQ: 480, NVDA: 140, AAPL: 220, TSLA: 250, MSFT: 410, AMD: 165,
  };

  for (let i = 0; i < 10; i++) {
    const symbol = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
    const price = spots[symbol] * (1 + (Math.random() - 0.5) * 0.01);
    const size = Math.floor(Math.random() * 100_000 + 10_000);

    darkPoolPrints.unshift({
      id: `dp-${Date.now()}-${i}`,
      timestamp: new Date(Date.now() - 86_400_000).toISOString(),
      symbol,
      price: parseFloat(price.toFixed(2)),
      size,
      notional: parseFloat((price * size).toFixed(0)),
      exchange: ['FINRA', 'IEX', 'EDGX'][Math.floor(Math.random() * 3)],
      source: 'simulation',
    });
  }

  if (darkPoolPrints.length > MAX_DP_PRINTS) {
    darkPoolPrints = darkPoolPrints.slice(0, MAX_DP_PRINTS);
  }
}

/**
 * Backfill so the feed is populated on first paint.
 *
 * Seeds run through the same engine as live flow — no second scoring path —
 * which means they must be fed in ascending timestamp order, as the engine
 * requires. `drainIdle` is bypassed here in favour of an explicit flush.
 */
function seedInitialData(): void {
  const symbols = Object.keys(SIM_SPOTS);
  const now = Date.now();

  const prints: RawPrint[] = [];
  for (let i = 0; i < 60; i++) {
    const symbol = symbols[Math.floor(Math.random() * symbols.length)]!;
    // Spread across the last hour, oldest first.
    const ts = now - Math.round((60 - i) * 60_000 * (0.6 + Math.random() * 0.4));
    prints.push(...simulatePrints(symbol, SIM_SPOTS[symbol]!, ts)
      .map((pr) => ({ ...pr, source: 'seed' })));
  }
  prints.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

  const seeded = prints.flatMap(ingestPrint);
  seeded.push(...drainIdle(0));
  emitSignals(seeded);

  addDarkPoolPrints();

}



// ─── CBOE delayed options chains ─────────────────────────────────────────────
// Real strikes, OI and greeks with no API key. Polled one symbol at a time:
// an SPX chain is ~13MB of JSON, and Render's free tier has 512MB.
const CBOE_SYMBOLS = ['SPY', 'QQQ', 'NVDA', 'TSLA', 'AAPL', 'SPX'];
let cboeIdx = 0;

function startCboeOptions(): void {
  const gate = gateFor('cboe_options');
  if (!gate.allowed) { markRefused('cboe_options', gate); return; }

  async function tick() {
    const sym = CBOE_SYMBOLS[cboeIdx % CBOE_SYMBOLS.length]!;
    cboeIdx++;
    try {
      const snap = await fetchCboeChain(sym);
      if (snap) {
        sources['cboe_options'] = 'connected';
        delete sourceErrors['cboe_options'];
      }
    } catch (err: any) {
      sources['cboe_options'] = 'error';
      sourceErrors['cboe_options'] = describeHttpError(err);
    }
  }
  void tick();
  setInterval(() => { void tick(); }, 20_000).unref();
}

// ─── OCC cleared volume ──────────────────────────────────────────────────────
function startOcc(): void {
  const gate = gateFor('occ');
  if (!gate.allowed) { markRefused('occ', gate); return; }

  async function tick() {
    try {
      await fetchOccVolume();
      sources['occ'] = 'connected';
      delete sourceErrors['occ'];
    } catch (err: any) {
      sources['occ'] = 'error';
      sourceErrors['occ'] = describeHttpError(err);
    }
  }
  void tick();
  setInterval(() => { void tick(); }, 300_000).unref();
}
