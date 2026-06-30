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
          timestamp: msg.timestamp ?? Date.now(),
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
