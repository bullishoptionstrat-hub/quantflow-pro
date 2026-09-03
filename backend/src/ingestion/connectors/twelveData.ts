/**
 * Twelve Data — Real-time stock quotes, technicals, earnings
 * Free: 800 API credits/day, WebSocket streaming included
 * Docs: https://twelvedata.com/docs
 */
import axios from 'axios';
import WebSocket from 'ws';

const API_KEY = process.env.TWELVE_DATA_API_KEY || '';
const BASE = 'https://api.twelvedata.com';
const WS_URL = 'wss://ws.twelvedata.com/v1/quotes/price';
const WATCHED = ['SPY', 'QQQ', 'NVDA', 'AAPL', 'TSLA', 'MSFT', 'AMD', 'META', 'AMZN', 'MSTR'];

export interface SpotQuote {
  symbol: string;
  price: number;
  change: number;
  changePct: number;
  volume: number;
  timestamp: number;
  source: 'twelvedata';
}

/**
 * One clock for `SpotQuote.timestamp`.
 *
 * The two paths that write this cache disagreed about the unit. TwelveData's
 * WebSocket stamps its price events in unix **seconds**; `fetchQuotesBatch`
 * stamps `Date.now()`, in **milliseconds**. Both went into the same field, so
 * the cache held quotes measured on two scales and the first consumer to
 * compare one against `Date.now()` would read every streamed quote as 1970 —
 * i.e. as permanently stale. Nothing read the field until the ticker tape did,
 * which is why it survived.
 *
 * Anything below 1e12 is seconds (1e12 ms is 2001, and no equity quote we
 * accept predates that); anything at or above it is already milliseconds. A
 * missing or unparseable stamp falls back to receipt time rather than to zero,
 * because a quote we just received is not a quote from the epoch.
 *
 * The REST path now publishes the vendor's own stamp where it sends one,
 * instead of overwriting it with receipt time — the same rule as
 * `RawPrint.quoteTs`. Stamping a quote from the last session as if it arrived
 * now manufactures exactly the freshness a staleness check exists to judge,
 * and off-hours is when that misreads worst.
 */
export function quoteTimestamp(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
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

export function getSpotPrice(symbol: string): number {
  return spotCache.get(symbol)?.price ?? 0;
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
          price: parseFloat(msg.price),
          change: parseFloat(msg.day_change ?? 0),
          changePct: parseFloat(msg.day_change_percent ?? 0),
          volume: parseInt(msg.volume ?? 0),
          timestamp: quoteTimestamp(msg.timestamp),
          source: 'twelvedata',
        };
        spotCache.set(msg.symbol, quote);
        onSpotUpdate?.(quote);
        wsCreditsUsed++;
      }
    } catch {}
  });

  ws.on('error', () => {});
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
        price: parseFloat(q.close ?? q.price ?? 0),
        change: parseFloat(q.change ?? 0),
        changePct: parseFloat(q.percent_change ?? 0),
        volume: parseInt(q.volume ?? 0),
        timestamp: quoteTimestamp(q.timestamp),
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
