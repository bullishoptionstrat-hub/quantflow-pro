/**
 * QuantFlow Pro — Ingestion Pipeline v3
 *
 * Classification and scoring run through `flowEngineAdapter` (the vendored
 * flow-engine), not the legacy heatScore/sweepDetector pair. Every source
 * normalizes to a RawPrint and funnels through `ingestPrint()`; the engine
 * emits classified signals on burst close, which are batched to Socket.IO.
 *
 * Sources: Tradier, Polygon, Finnhub + 13 free connectors:
 *   FlashAlpha · MarketData.app · Schwab · Tastytrade · TwelveData · FMP
 *   CoinGecko · FRED · Reddit · NewsAPI · CBOE · Yahoo · Stooq
 */
import axios from 'axios';
import WebSocket from 'ws';
import { fetchCboeChain, getCboeSnapshot, getCboeSymbols } from './connectors/cboeOptions';
import { fetchOccVolume, getOccVolume } from './connectors/occ';
import { describeHttpError } from './httpError';
import {
  ingestPrint, drainIdle, resetDaily, onSignal,
  type RawPrint, type WireFlowEvent,
} from './flowEngineAdapter';
import {
  initPersistence, describePersistence, SignalGrader,
  type SignalRecord,
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
  startTwelveData, onTwelveDataSpot,
  getSpotQuotes, getSpotPrice,
} from './connectors/twelveData';
import {
  startFMP, getEarnings, getInsiderTrades, getFMPNews,
} from './connectors/fmp';
import {
  startCoinGecko, onCoinGeckoUpdate,
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
  getSpotQuotes, getSpotPrice,
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
  heatScore: number;
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
  callOI: number;
  putOI: number;
  callGamma: number;
  putGamma: number;
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
 * `CONNECTOR_CREDENTIALS`. Tradier, Polygon and Finnhub start on their own
 * paths and set `disabled` with no reason at all — so /api/health reported
 * three sources as off and named nothing an operator could act on, which is
 * the gap the credentials table was introduced to close everywhere else.
 */
function markNoCredentials(source: string, vars: string[]): void {
  sources[source] = 'disabled';
  sourceErrors[source] =
    `No credentials — ${vars.join(', ')} ${vars.length === 1 ? 'is' : 'are'} not set. ` +
    `The connector is not contributing data.`;
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
  // Real chain first. CBOE publishes per-contract gamma and open interest, so
  // this is a direct computation; generateSyntheticGEX below is a fallback for
  // symbols CBOE hasn't been polled for yet, not a preference.
  const snap = getCboeSnapshot(symbol);
  if (snap && snap.gex.length > 0) {
    gexCache[symbol] = { levels: snap.gex, fetchedAt: Date.now() };
    return snap.gex;
  }

  const cached = gexCache[symbol];
  if (cached && Date.now() - cached.fetchedAt < 60_000) {
    return cached.levels;
  }
  const levels = generateSyntheticGEX(symbol);
  gexCache[symbol] = { levels, fetchedAt: Date.now() };
  return levels;
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
    callPutRatio: puts.length > 0 ? parseFloat((calls.length / puts.length).toFixed(2)) : 0,
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

  return {
    active: ingestionActive,
    sources,
    sourceErrors,
    sourceNotes: notes,
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
  // The three legacy connectors start on their own paths rather than through
  // `startConnector`, and were left out of this table for that reason. They
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
  startFinnhubIngestion();

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
      sources['fred'] = 'connected';
      delete sourceErrors['fred'];
    } else {
      sources['fred'] = 'error';
      sourceErrors['fred'] = h.reason ?? 'FRED fetch failed.';
    }
  });
  onRedditSentiment((s) => {
    if (ioInstance) ioInstance.emit('sentiment_update', s);
  });
  onNewsHeadline((h) => {
    if (ioInstance) ioInstance.emit('news_update', h);
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

  // Drain bursts the engine is holding once the feed goes quiet — it finalizes
  // on the next trade's watermark, so an idle feed would sit on its last signal.
  setInterval(() => emitSignals(drainIdle()), 1_000);

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
  }, 60_000);

  // Refresh GEX every 60 seconds
  setInterval(() => {
    ['SPX', 'SPY', 'QQQ', 'NVDA'].forEach((s) => {
      gexCache[s] = { levels: generateSyntheticGEX(s), fetchedAt: Date.now() };
    });
  }, 60_000);

  // Dark pool simulation refresh every 5 minutes
  setInterval(addDarkPoolPrints, 300_000);

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
        } catch {}
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
            strike: details.strike_price ?? 0,
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

  setInterval(poll, 10_000);
  poll();
}

// ─── Finnhub trade streaming ─────────────────────────────────────────────────

const FINNHUB_KEY = process.env.FINNHUB_API_KEY || '';

function startFinnhubIngestion(): void {
  if (!FINNHUB_KEY) {
    markNoCredentials('finnhub', ['FINNHUB_API_KEY']);
    return;
  }

  const ws = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_KEY}`);

  ws.on('open', () => {
    sources['finnhub'] = 'connected';
    WATCHED_SYMBOLS.slice(0, 5).forEach((sym) => {
      ws.send(JSON.stringify({ type: 'subscribe', symbol: sym }));
    });
  });

  ws.on('message', (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'trade' && Array.isArray(msg.data)) {
        for (const t of msg.data) {
          if (Math.random() > 0.85) {
            generateFlowFromSpot(t.s, t.p, 'finnhub');
          }
        }
      }
    } catch {}
  });

  ws.on('error', () => { sources['finnhub'] = 'error'; });
  ws.on('close', () => {
    sources['finnhub'] = 'error';
    setTimeout(startFinnhubIngestion, 10_000);
  });
}

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
  }, 3000);

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
    exchanges: venues,
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

  // 12% of orders are a two-leg vertical: same right and expiry, second strike,
  // both legs printing inside the engine's multi-leg window.
  if (Math.random() < 0.12) {
    const farStrike = strike + (right === 'C' ? 10 : -10);
    const farPrice = parseFloat(Math.max(0.05, fill * 0.45).toFixed(2));
    return [base, {
      ...base,
      id: `${base.id}-leg2`,
      ts: ts + 5,
      strike: farStrike,
      price: farPrice,
      bid: parseFloat(Math.max(0.01, farPrice - 0.05).toFixed(2)),
      ask: parseFloat((farPrice + 0.05).toFixed(2)),
      exchanges: ['CBOE'],
      iso: false,
    }];
  }

  return [base];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Synthesize option flow from an equity spot tick (Finnhub streams equity
 * trades, not options tape). Flagged synthetic — it is inference, not tape.
 */
function generateFlowFromSpot(symbol: string, spotPrice: number, source: string): void {
  if (!(spotPrice > 0)) return;
  const prints = simulatePrints(symbol, spotPrice, Date.now())
    .map((pr) => ({ ...pr, source }));
  emitSignals(prints.flatMap(ingestPrint));
}

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
 * Subscribe the recorder and grader to the engine's output.
 *
 * This is the difference between a terminal that shows flow and a system that
 * remembers it. Without it, every signal this process classifies is discarded
 * within 500 events, the ring buffer dies with the process, and no track
 * record can ever accumulate no matter how long the service runs.
 */
function startSignalHistory(): void {
  const { store, recorder } = initPersistence();

  // Underlying marks come from TwelveData's spot cache. Yahoo is deliberately
  // NOT consulted as a fallback: its terms prohibit automated access for any
  // purpose, so it is refused in the rights registry, and reaching for it here
  // would route around that refusal.
  grader = new SignalGrader(store, (underlying) => {
    const px = getSpotPrice(underlying);
    return px > 0 ? px : undefined;
  });

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
  setInterval(() => {
    void grader?.tick().catch(() => { /* counted in grader stats */ });
  }, 60_000);

  const p = describePersistence();
  console.log(`[history] store=${p.store} durable=${p.durable} mode=${p.businessMode}`);
  if (!p.durable) console.warn(`[history] ${p.reason}`);
}

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
    // Flags that something failed without saying what. The detail is one
    // authenticated call away, at /api/track-record.
    errorsSuppressed: Boolean(p.recorder?.lastError || graderStats?.lastError),
    rights: rightsSnapshot(),
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

  ['SPX', 'SPY', 'QQQ', 'NVDA'].forEach((sym) => {
    gexCache[sym] = { levels: generateSyntheticGEX(sym), fetchedAt: Date.now() };
  });
}

function generateSyntheticGEX(symbol: string): GEXLevel[] {
  const spotMap: Record<string, number> = {
    SPX: 5800, SPY: 580, QQQ: 480, NVDA: 140, AAPL: 220, TSLA: 250, MSFT: 410,
  };
  const spot = spotMap[symbol] ?? 100;
  const levels: GEXLevel[] = [];

  for (let i = -15; i <= 15; i++) {
    const strike = Math.round((spot * (1 + i * 0.005)) / 5) * 5;
    const distFromSpot = Math.abs(i);
    const atm = distFromSpot <= 2;

    const callOI = Math.floor((atm ? 50000 : 20000) * Math.exp(-distFromSpot * 0.3) + Math.random() * 5000);
    const putOI = Math.floor((atm ? 45000 : 18000) * Math.exp(-distFromSpot * 0.3) + Math.random() * 5000);
    const callGamma = 0.03 * Math.exp(-distFromSpot * 0.4);
    const putGamma = 0.025 * Math.exp(-distFromSpot * 0.4);
    const netGEX = (callOI * callGamma - putOI * putGamma) * spot * spot * 0.01;

    levels.push({
      strike,
      gex: parseFloat(netGEX.toFixed(2)),
      callOI, putOI,
      callGamma: parseFloat(callGamma.toFixed(6)),
      putGamma: parseFloat(putGamma.toFixed(6)),
    });
  }

  return levels.sort((a, b) => a.strike - b.strike);
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
  setInterval(() => { void tick(); }, 20_000);
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
  setInterval(() => { void tick(); }, 300_000);
}
