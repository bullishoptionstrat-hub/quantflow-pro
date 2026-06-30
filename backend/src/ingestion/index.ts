/**
 * QuantFlow Pro — Ingestion Pipeline v2
 * Sources: Tradier, Polygon, Finnhub + 13 new free connectors:
 *   FlashAlpha · MarketData.app · Schwab · Tastytrade · TwelveData · FMP
 *   CoinGecko · FRED · Reddit · NewsAPI · CBOE · Yahoo · Stooq
 */
import axios from 'axios';
import WebSocket from 'ws';
import { computeHeatScore } from './heatScore';
import { classifySweep } from './sweepDetector';

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

export interface FlowEvent {
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

// ─── Public getters ─────────────────────────────────────────────────────────

export function getRecentFlow(): FlowEvent[] {
  return [...flowEvents];
}

export function getDarkPoolPrints(): DarkPoolPrint[] {
  return [...darkPoolPrints];
}

export function getGEXLevels(symbol: string): GEXLevel[] {
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
  const calls = events.filter((e) => e.callPut === 'C');
  const puts = events.filter((e) => e.callPut === 'P');
  const callPremium = calls.reduce((s, e) => s + e.premium, 0);
  const putPremium = puts.reduce((s, e) => s + e.premium, 0);
  const totalPremium = callPremium + putPremium;
  const sweeps = events.filter((e) => e.type === 'SWEEP').length;

  return {
    totalTrades: events.length,
    totalPremium,
    callPremium,
    putPremium,
    callPutRatio: puts.length > 0 ? parseFloat((calls.length / puts.length).toFixed(2)) : 0,
    sweepCount: sweeps,
    bullishCount: events.filter((e) => e.sentiment === 'bullish').length,
    bearishCount: events.filter((e) => e.sentiment === 'bearish').length,
    unusualCount: events.filter((e) => (e.unusualScore ?? 0) >= 75).length,
    sources,
  };
}

export function getIngestionStatus() {
  return { active: ingestionActive, sources };
}

// ─── Initializer ────────────────────────────────────────────────────────────

export function startIngestion(io: any): void {
  ioInstance = io;
  ingestionActive = true;

  // Seed with realistic data immediately
  seedInitialData();

  // ── Legacy connectors ──
  startTradierIngestion();
  startPolygonIngestion();
  startFinnhubIngestion();

  // ── 13 New connectors ──
  // Wire incoming flow events from market-data connectors into central store
  onMarketDataFlow((e) => addFlowEvent({ ...e, source: 'marketdata' }));
  onSchwabFlow((e) => addFlowEvent({ ...e, source: 'schwab' }));
  onTastytradeFlow((e) => addFlowEvent({ ...e, source: 'tastytrade' }));
  onYahooFlow((e) => addFlowEvent({ ...e, source: 'yahoo' }));

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

  // Refresh GEX every 60 seconds
  setInterval(() => {
    ['SPX', 'SPY', 'QQQ', 'NVDA'].forEach((s) => {
      gexCache[s] = { levels: generateSyntheticGEX(s), fetchedAt: Date.now() };
    });
  }, 60_000);

  // Dark pool simulation refresh every 5 minutes
  setInterval(addDarkPoolPrints, 300_000);

  console.log('[ingestion] v2 started — seeded', flowEvents.length, 'events, 13 new connectors initializing');
}

// ─── Tradier WebSocket ───────────────────────────────────────────────────────

const TRADIER_TOKEN = process.env.TRADIER_TOKEN || '';
const TRADIER_WS = 'wss://ws.tradier.com/v1/markets/events';
const WATCHED_SYMBOLS = [
  'SPY', 'QQQ', 'SPX', 'NVDA', 'AAPL', 'TSLA', 'MSFT',
  'MSTR', 'MU', 'MRVL', 'AMD', 'META', 'AMZN', 'GOOG',
];

let tradierWs: WebSocket | null = null;

function startTradierIngestion(): void {
  if (!TRADIER_TOKEN) {
    console.log('[tradier] No token — skipping WebSocket, using simulation');
    sources['tradier'] = 'disabled';
    startSimulationFeed();
    return;
  }

  function connect() {
    try {
      tradierWs = new WebSocket(TRADIER_WS, {
        headers: { Authorization: `Bearer ${TRADIER_TOKEN}` },
      });

      tradierWs.on('open', () => {
        sources['tradier'] = 'connected';
        const msg = JSON.stringify({
          symbols: WATCHED_SYMBOLS,
          sessionid: 'quantflow',
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
        console.error('[tradier] WS error:', err.message);
      });

      tradierWs.on('close', () => {
        sources['tradier'] = 'error';
        console.log('[tradier] WS closed — reconnecting in 5s');
        setTimeout(connect, 5000);
      });
    } catch (err: any) {
      console.error('[tradier] connect failed:', err.message);
      sources['tradier'] = 'error';
      startSimulationFeed();
    }
  }

  connect();
}

function processMarketTick(data: any, source: string): void {
  if (!data.symbol || !data.price || !data.size) return;

  const isOption = data.symbol?.match(/[0-9]{6}[CP][0-9]+/);
  if (!isOption) return;

  const match = data.symbol.match(/([A-Z]+)(\d{6})([CP])(\d+)/);
  if (!match) return;

  const [, sym, dateStr, cpFlag, strikeStr] = match;
  const expiration = `20${dateStr.slice(0, 2)}-${dateStr.slice(2, 4)}-${dateStr.slice(4, 6)}`;
  const strike = parseInt(strikeStr) / 1000;
  const size = parseInt(data.size);
  const price = parseFloat(data.price);
  const premium = price * size * 100;

  const bid = parseFloat(data.bid ?? price * 0.99);
  const ask = parseFloat(data.ask ?? price * 1.01);

  const heatScore = computeHeatScore({
    bid, ask, price, size,
    avgVolume: size * 10,
    openInterest: size * 50,
  });

  const type = classifySweep({ size, exchanges: [data.exch ?? 'C'] });
  const sentiment = cpFlag === 'C'
    ? (price > (bid + ask) / 2 ? 'bullish' : 'neutral')
    : (price > (bid + ask) / 2 ? 'bearish' : 'neutral');

  addFlowEvent({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
    symbol: sym,
    expiration, strike,
    callPut: cpFlag as 'C' | 'P',
    type, size, premium, heatScore, sentiment, source,
    bid, ask,
    exchange: data.exch,
  });
}

// ─── Polygon REST polling ────────────────────────────────────────────────────

const POLYGON_KEY = process.env.POLYGON_API_KEY || '';

function startPolygonIngestion(): void {
  if (!POLYGON_KEY) {
    sources['polygon'] = 'disabled';
    return;
  }

  sources['polygon'] = 'connected';

  async function poll() {
    try {
      const { data } = await axios.get(
        `https://api.polygon.io/v3/trades/options?limit=25&apiKey=${POLYGON_KEY}`,
        { timeout: 5000 }
      );

      if (data?.results) {
        for (const t of data.results) {
          if (!t.sip_timestamp || !t.price || !t.size) continue;

          const heatScore = computeHeatScore({
            bid: t.price * 0.99,
            ask: t.price * 1.01,
            price: t.price,
            size: t.size,
            avgVolume: t.size * 8,
            openInterest: t.size * 40,
          });

          addFlowEvent({
            id: `poly-${t.sequence_number ?? Date.now()}`,
            timestamp: new Date(t.sip_timestamp / 1_000_000).toISOString(),
            symbol: t.underlying_asset?.ticker ?? 'UNK',
            expiration: t.details?.expiration_date ?? '',
            strike: t.details?.strike_price ?? 0,
            callPut: t.details?.contract_type === 'call' ? 'C' : 'P',
            type: classifySweep({ size: t.size, exchanges: [t.exchange ?? 'C'] }),
            size: t.size,
            premium: t.price * t.size * 100,
            heatScore,
            sentiment: t.details?.contract_type === 'call' ? 'bullish' : 'bearish',
            source: 'polygon',
            bid: t.price * 0.99,
            ask: t.price * 1.01,
            exchange: String(t.exchange),
          });
        }
      }
    } catch (err: any) {
      if (err.response?.status === 403) sources['polygon'] = 'error';
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

function startSimulationFeed(): void {
  if (simInterval) return;

  const SYMBOLS = ['SPY', 'QQQ', 'NVDA', 'AAPL', 'TSLA', 'MSFT', 'MSTR', 'AMD'];
  const spotPrices: Record<string, number> = {
    SPY: 580, QQQ: 480, NVDA: 140, AAPL: 220, TSLA: 250, MSFT: 410, MSTR: 380, AMD: 165,
  };

  sources['simulation'] = 'connected';

  simInterval = setInterval(() => {
    const symbol = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
    const spot = spotPrices[symbol] * (1 + (Math.random() - 0.5) * 0.002);
    spotPrices[symbol] = spot;
    generateFlowFromSpot(symbol, spot, 'simulation');
  }, 3000);

  console.log('[ingestion] Simulation feed running');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateFlowFromSpot(symbol: string, spotPrice: number, source: string): void {
  const isCall = Math.random() > 0.45;
  const dteIndex = Math.floor(Math.random() * 4);
  const dteDays = [7, 14, 30, 60][dteIndex];
  const exp = new Date();
  exp.setDate(exp.getDate() + dteDays);
  const expStr = exp.toISOString().split('T')[0];

  const strikeDelta = (Math.random() - 0.5) * spotPrice * 0.05;
  const strike = Math.round((spotPrice + strikeDelta) / 5) * 5;

  const optionPrice = Math.max(0.05, Math.abs(strikeDelta) * 0.3 + Math.random() * 2);
  const size = Math.floor(Math.random() * 300 + 10);
  const bid = optionPrice * 0.98;
  const ask = optionPrice * 1.02;
  const fillPrice = bid + Math.random() * (ask - bid);
  const premium = fillPrice * size * 100;

  const heatScore = computeHeatScore({
    bid, ask, price: fillPrice, size,
    avgVolume: size * 5,
    openInterest: size * 30,
  });

  const type = classifySweep({ size, exchanges: size > 200 ? ['C', 'P', 'X'] : ['C'] });

  const sentiment = isCall
    ? (fillPrice > (bid + ask) / 2 ? 'bullish' : 'neutral')
    : (fillPrice > (bid + ask) / 2 ? 'bearish' : 'neutral');

  addFlowEvent({
    id: `sim-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    symbol, expiration: expStr, strike,
    callPut: isCall ? 'C' : 'P',
    type, size, premium, heatScore, sentiment, source,
    bid, ask,
    unusualScore: heatScore > 70 ? Math.round(heatScore + Math.random() * 10) : undefined,
  });
}

function addFlowEvent(event: FlowEvent): void {
  flowEvents.unshift(event);
  if (flowEvents.length > MAX_FLOW_EVENTS) {
    flowEvents = flowEvents.slice(0, MAX_FLOW_EVENTS);
  }
  if (ioInstance) {
    ioInstance.emit('flow_update', event);
    ioInstance.to(event.symbol).emit('flow_update', event);
  }
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

function seedInitialData(): void {
  const SYMBOLS = ['SPY', 'QQQ', 'NVDA', 'AAPL', 'TSLA', 'MSFT', 'MSTR', 'AMD', 'META', 'AMZN'];
  const spots: Record<string, number> = {
    SPY: 580, QQQ: 480, NVDA: 140, AAPL: 220, TSLA: 250,
    MSFT: 410, MSTR: 380, AMD: 165, META: 560, AMZN: 195,
  };

  for (let i = 0; i < 50; i++) {
    const symbol = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
    const spot = spots[symbol];
    const ts = new Date(Date.now() - Math.floor(Math.random() * 3_600_000));

    const isCall = Math.random() > 0.4;
    const dteDays = [7, 14, 30, 60][Math.floor(Math.random() * 4)];
    const exp = new Date(ts);
    exp.setDate(exp.getDate() + dteDays);
    const expStr = exp.toISOString().split('T')[0];

    const strikeDelta = (Math.random() - 0.5) * spot * 0.05;
    const strike = Math.round((spot + strikeDelta) / 5) * 5;
    const optionPrice = Math.max(0.05, Math.abs(strikeDelta) * 0.3 + Math.random() * 2);
    const size = Math.floor(Math.random() * 500 + 20);
    const bid = optionPrice * 0.98;
    const ask = optionPrice * 1.02;
    const fillPrice = bid + Math.random() * (ask - bid);
    const premium = fillPrice * size * 100;

    const heatScore = computeHeatScore({
      bid, ask, price: fillPrice, size,
      avgVolume: size * 5,
      openInterest: size * 30,
    });

    const type = classifySweep({ size, exchanges: size > 200 ? ['C', 'P', 'X'] : ['C'] });

    flowEvents.push({
      id: `seed-${i}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: ts.toISOString(),
      symbol, expiration: expStr, strike,
      callPut: isCall ? 'C' : 'P',
      type, size, premium, heatScore,
      sentiment: isCall
        ? fillPrice > (bid + ask) / 2 ? 'bullish' : 'neutral'
        : fillPrice > (bid + ask) / 2 ? 'bearish' : 'neutral',
      source: 'seed', bid, ask,
      unusualScore: heatScore > 70 ? Math.round(heatScore + Math.random() * 10) : undefined,
    });
  }

  flowEvents.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  addDarkPoolPrints();

  ['SPX', 'SPY', 'QQQ', 'NVDA'].forEach((s) => {
    gexCache[s] = { levels: generateSyntheticGEX(s), fetchedAt: Date.now() };
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
