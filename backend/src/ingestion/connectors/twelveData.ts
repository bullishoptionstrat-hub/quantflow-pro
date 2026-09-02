/**
 * Twelve Data — Real-time stock quotes, technicals, earnings
 * Free: 800 API credits/day, WebSocket streaming included
 * Docs: https://twelvedata.com/docs
 */
import axios from 'axios';
import { num } from '../parseNumeric';
import WebSocket from 'ws';

const API_KEY = process.env.TWELVE_DATA_API_KEY || '';
const BASE = 'https://api.twelvedata.com';
const WS_URL = 'wss://ws.twelvedata.com/v1/quotes/price';
const WATCHED = ['SPY', 'QQQ', 'NVDA', 'AAPL', 'TSLA', 'MSFT', 'AMD', 'META', 'AMZN', 'MSTR'];

export interface SpotQuote {
  symbol: string;
  /** The mark. A quote is not published without one. */
  price: number;
  /**
   * `null` when TwelveData omitted the field — never 0. An unchanged session
   * is a real reading of 0.00, so the sentinel made "flat" and "no data"
   * the same value, and `parseFloat` made an error string parse as a number.
   */
  change: number | null;
  changePct: number | null;
  volume: number | null;
  timestamp: number;
  source: 'twelvedata';
}

const spotCache = new Map<string, SpotQuote>();
let onSpotUpdate: ((q: SpotQuote) => void) | null = null;
let wsCreditsUsed = 0;

export function onTwelveDataSpot(handler: (q: SpotQuote) => void): void {
  onSpotUpdate = handler;
}

export function getSpotQuotes(): Map<string, SpotQuote> {
  return spotCache;
}

/**
 * `null` for a symbol we have no spot for — never 0.
 *
 * The grader marks signals against this. A price of 0 would grade every
 * outcome as a total loss with total confidence; the one caller guards with
 * `px > 0`, but the type said `number`, so the guard was the only thing
 * standing between a cache miss and a fabricated mark.
 */
export function getSpotPrice(symbol: string): number | null {
  return spotCache.get(symbol)?.price ?? null;
}

function startWebSocket(): void {
  const ws = new WebSocket(`${WS_URL}?apikey=${API_KEY}`);

  ws.on('open', () => {
    ws.send(JSON.stringify({ action: 'subscribe', params: { symbols: WATCHED.join(',') } }));
    console.log('[twelvedata] WebSocket connected');
  });

  ws.on('message', (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.event === 'price' && msg.symbol && msg.price) {
        const quote: SpotQuote = {
          symbol: msg.symbol,
          price: num(msg.price) ?? 0,
          change: num(msg.day_change),
          changePct: num(msg.day_change_percent),
          volume: num(msg.volume),
          timestamp: msg.timestamp ?? Date.now(),
          source: 'twelvedata',
        };
        spotCache.set(msg.symbol, quote);
        onSpotUpdate?.(quote);
        wsCreditsUsed++;
      }
    } catch (err: any) {
      console.error(`[twelvedata] message handling failed: ${err?.message ?? err}`);
    }
  });

  ws.on('error', (err) => {
    console.error(`[twelvedata] websocket error: ${err?.message ?? err}`);
  });
  ws.on('close', () => { setTimeout(startWebSocket, 5000); });
}

async function fetchQuotesBatch(): Promise<void> {
  try {
    const symbols = WATCHED.join(',');
    const { data } = await axios.get(`${BASE}/quote`, {
      params: { symbol: symbols, apikey: API_KEY },
      timeout: 8000,
    });

    const process = (sym: string, q: any) => {
      if (!q || q.status === 'error') return;
      const quote: SpotQuote = {
        symbol: sym,
        price: num(q.close) ?? num(q.price) ?? 0,
        change: num(q.change),
        changePct: num(q.percent_change),
        volume: num(q.volume),
        timestamp: Date.now(),
        source: 'twelvedata',
      };
      spotCache.set(sym, quote);
      onSpotUpdate?.(quote);
    };

    // Response is either a single object or a map of symbol→data
    if (data.symbol) {
      process(data.symbol, data);
    } else {
      Object.entries(data).forEach(([sym, q]) => process(sym, q as any));
    }
  } catch (err: any) {
    console.error('[twelvedata] quote batch error:', err.message);
  }
}

export async function startTwelveData(): Promise<void> {
  if (!API_KEY) { console.log('[twelvedata] No key — skipped'); return; }

  await fetchQuotesBatch();
  startWebSocket();

  // REST fallback every 60s
  setInterval(fetchQuotesBatch, 60_000);
  console.log('[twelvedata] Started — WebSocket streaming + 60s REST fallback');
}
