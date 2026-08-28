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
  ingestPrint, drainIdle, resetDaily,
  type RawPrint, type WireFlowEvent,
} from './flowEngineAdapter';

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
  startFRED, onFREDUpdate,
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
  startStooq, onStooqQuote, getStooqQuotes,
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
let sources: Record<string, 'connected' | 'error' | 'disabled'> = {};
// Why a source is in 'error'. Surfaced via /api/health because the hosting
// platform's logs aren't always reachable when diagnosing a live deploy.
// Status codes and messages only — never credentials.
let sourceErrors: Record<string, string> = {};

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
  return { active: ingestionActive, sources, sourceErrors, occ: getOccVolume() };
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

export function startIngestion(io: any): void {
  ioInstance = io;
  ingestionActive = true;

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
  onYahooQuote((q) => {
    if (ioInstance) ioInstance.emit('spot_update', q);
  });
  onStooqQuote((q) => {
    if (ioInstance) ioInstance.emit('stooq_update', q);
  });

  // Wire macro/sentiment events to broadcast
  onCoinGeckoUpdate((q) => {
    if (ioInstance) ioInstance.emit('crypto_update', q);
  });
  onFREDUpdate((s) => {
    if (ioInstance) ioInstance.emit('macro_update', s);
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
    startFlashAlpha().then(() => { sources['flashalpha'] = 'connected'; })
      .catch(() => { sources['flashalpha'] = 'disabled'; }),
    startMarketData().then(() => { sources['marketdata'] = 'connected'; })
      .catch(() => { sources['marketdata'] = 'disabled'; }),
    startSchwab().then(() => { sources['schwab'] = 'connected'; })
      .catch(() => { sources['schwab'] = 'disabled'; }),
    startTastytrade().then(() => { sources['tastytrade'] = 'connected'; })
      .catch(() => { sources['tastytrade'] = 'disabled'; }),
    startTwelveData().then(() => { sources['twelvedata'] = 'connected'; })
      .catch(() => { sources['twelvedata'] = 'disabled'; }),
    startFMP().then(() => { sources['fmp'] = 'connected'; })
      .catch(() => { sources['fmp'] = 'disabled'; }),
    startCoinGecko().then(() => { sources['coingecko'] = 'connected'; })
      .catch(() => { sources['coingecko'] = 'disabled'; }),
    startFRED().then(() => { sources['fred'] = 'connected'; })
      .catch(() => { sources['fred'] = 'disabled'; }),
    startReddit().then(() => { sources['reddit'] = 'connected'; })
      .catch(() => { sources['reddit'] = 'disabled'; }),
    startNewsAPI().then(() => { sources['newsapi'] = 'connected'; })
      .catch(() => { sources['newsapi'] = 'disabled'; }),
    startCBOE().then(() => { sources['cboe'] = 'connected'; })
      .catch(() => { sources['cboe'] = 'disabled'; }),
    startYahoo().then(() => { sources['yahoo'] = 'connected'; })
      .catch(() => { sources['yahoo'] = 'disabled'; }),
    startStooq().then(() => { sources['stooq'] = 'connected'; })
      .catch(() => { sources['stooq'] = 'disabled'; }),
  ]).then((results) => {
    const connected = results.filter((r) => r.status === 'fulfilled').length;
    console.log(`[ingestion] ${connected}/13 new connectors started`);
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
    sources['tradier'] = 'disabled';
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

function startPolygonIngestion(): void {
  if (!POLYGON_KEY) {
    sources['polygon'] = 'disabled';
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

      if (data?.results) {
        for (const t of data.results) {
          if (!t.sip_timestamp || !t.price || !t.size) continue;
          const details = t.details ?? {};
          if (!details.expiration_date) continue;

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
            // No NBBO: the trades endpoint carries no quote, so side stays
            // AMBIGUOUS here by design. Pre-v3 this path fabricated a ±1%
            // bid/ask and inferred a side from it. Wiring the Polygon quotes
            // feed is what makes this path directional.
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
    sources['finnhub'] = 'disabled';
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
