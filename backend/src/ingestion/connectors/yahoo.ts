/**
 * Yahoo Finance — Stock quotes, options chains, earnings, historical
 * No API key required — public endpoints
 */
import axios from 'axios';
import { FlowEvent } from '../index';
import { computeHeatScore } from '../heatScore';
import { classifySweep } from '../sweepDetector';

const ENABLED = process.env.YAHOO_ENABLED !== 'false';
const WATCHED = ['SPY', 'QQQ', 'NVDA', 'AAPL', 'TSLA', 'MSFT', 'AMD', 'META', 'AMZN', 'MSTR', 'GLD', 'SLV'];
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

export interface YahooQuote {
  symbol: string;
  price: number;
  change: number;
  changePct: number;
  volume: number;
  marketCap: number;
  dayHigh: number;
  dayLow: number;
  fiftyTwoWeekHigh: number;
  fiftyTwoWeekLow: number;
  source: 'yahoo';
}

const quoteCache = new Map<string, YahooQuote>();
let onFlowEvent: ((e: FlowEvent) => void) | null = null;
let onQuoteUpdate: ((q: YahooQuote) => void) | null = null;

export function onYahooFlow(handler: (e: FlowEvent) => void): void { onFlowEvent = handler; }
export function onYahooQuote(handler: (q: YahooQuote) => void): void { onQuoteUpdate = handler; }
export function getYahooQuotes(): Map<string, YahooQuote> { return quoteCache; }

async function fetchQuotes(): Promise<void> {
  try {
    const symbols = WATCHED.join(',');
    const { data } = await axios.get(
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}`,
      { headers: HEADERS, timeout: 8000 }
    );

    const results = data?.quoteResponse?.result ?? [];
    for (const r of results) {
      const quote: YahooQuote = {
        symbol: r.symbol,
        price: r.regularMarketPrice ?? 0,
        change: r.regularMarketChange ?? 0,
        changePct: r.regularMarketChangePercent ?? 0,
        volume: r.regularMarketVolume ?? 0,
        marketCap: r.marketCap ?? 0,
        dayHigh: r.regularMarketDayHigh ?? 0,
        dayLow: r.regularMarketDayLow ?? 0,
        fiftyTwoWeekHigh: r.fiftyTwoWeekHigh ?? 0,
        fiftyTwoWeekLow: r.fiftyTwoWeekLow ?? 0,
        source: 'yahoo',
      };
      quoteCache.set(r.symbol, quote);
      onQuoteUpdate?.(quote);
    }
  } catch (err: any) {
    console.error('[yahoo] quote error:', err.message);
  }
}

async function fetchOptionFlow(symbol: string): Promise<void> {
  try {
    const { data } = await axios.get(
      `https://query1.finance.yahoo.com/v7/finance/options/${symbol}`,
      { headers: HEADERS, timeout: 8000 }
    );

    const result = data?.optionChain?.result?.[0];
    if (!result) return;

    const spot = result.quote?.regularMarketPrice ?? 0;
    const options = [...(result.options?.[0]?.calls ?? []), ...(result.options?.[0]?.puts ?? [])];

    for (const opt of options) {
      const size = opt.volume ?? 0;
      if (size < 100) continue;

      const bid = opt.bid ?? 0;
      const ask = opt.ask ?? 0;
      const last = opt.lastPrice ?? ((bid + ask) / 2);
      const oi = opt.openInterest ?? 0;
      const cp: 'C' | 'P' = opt.contractSymbol?.includes('C') ? 'C' : 'P';

      const heat = computeHeatScore({ bid, ask, price: last, size, avgVolume: size * 0.3, openInterest: oi });

      onFlowEvent?.({
        id: `yahoo-${opt.contractSymbol}-${Date.now()}`,
        timestamp: new Date().toISOString(),
        symbol,
        expiration: opt.expiration ? new Date(opt.expiration * 1000).toISOString().split('T')[0] : '',
        strike: opt.strike ?? 0,
        callPut: cp,
        type: classifySweep({ size, exchanges: ['C'] }),
        size,
        premium: last * size * 100,
        heatScore: heat,
        sentiment: cp === 'C' ? 'bullish' : 'bearish',
        source: 'yahoo',
        bid, ask, iv: opt.impliedVolatility,
      } as FlowEvent);
    }
  } catch {}
}

export async function startYahoo(): Promise<void> {
  if (!ENABLED) { console.log('[yahoo] Disabled'); return; }

  await fetchQuotes();
  setInterval(fetchQuotes, 30_000);

  // Fetch options for top symbols every 3 min (stagger to avoid rate limiting)
  let idx = 0;
  setInterval(() => {
    const sym = WATCHED[idx % WATCHED.length];
    fetchOptionFlow(sym);
    idx++;
  }, 15_000);

  console.log('[yahoo] Started — quotes every 30s, options chain cycling every 15s per symbol');
}
