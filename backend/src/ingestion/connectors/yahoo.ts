/**
 * Yahoo Finance — Stock quotes, options chains, earnings, historical
 * No API key required — public endpoints
 */
import axios from 'axios';
import { LegacyFlowEvent as FlowEvent } from '../index';
import { computeHeatScore } from '../heatScore';
import { classifySweep } from '../sweepDetector';
import { num, orUndefined } from '../optionalNumber';

const ENABLED = process.env.YAHOO_ENABLED !== 'false';
const WATCHED = ['SPY', 'QQQ', 'NVDA', 'AAPL', 'TSLA', 'MSFT', 'AMD', 'META', 'AMZN', 'MSTR', 'GLD', 'SLV'];
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

/**
 * A Yahoo spot quote. Nullable below `price` for the reason CoinGecko's
 * `CryptoQuote` is: these went out with `?? 0`, and a `spot_update` is
 * emitted straight to every connected socket, so a row Yahoo returned
 * without a price became a $0.00 quote with a 0.00% change on the tape —
 * rendered through the same markup as a live one.
 *
 * `price` stays non-null because a quote without one is not published at
 * all. There is nothing left to call it.
 */
export interface YahooQuote {
  symbol: string;
  price: number;
  change: number | null;
  changePct: number | null;
  volume: number | null;
  marketCap: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
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
      const price = num(r.regularMarketPrice);
      // No price is not a price of zero, and this one goes to the tape.
      if (price === null || !r.symbol) continue;

      const quote: YahooQuote = {
        symbol: r.symbol,
        price,
        change: num(r.regularMarketChange),
        changePct: num(r.regularMarketChangePercent),
        volume: num(r.regularMarketVolume),
        marketCap: num(r.marketCap),
        dayHigh: num(r.regularMarketDayHigh),
        dayLow: num(r.regularMarketDayLow),
        fiftyTwoWeekHigh: num(r.fiftyTwoWeekHigh),
        fiftyTwoWeekLow: num(r.fiftyTwoWeekLow),
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

    const options = [...(result.options?.[0]?.calls ?? []), ...(result.options?.[0]?.puts ?? [])];

    for (const opt of options) {
      const size = num(opt.volume);
      if (size === null || size < 100) continue;

      const bid = num(opt.bid);
      const ask = num(opt.ask);
      const oi = num(opt.openInterest);
      const strike = num(opt.strike);
      if (strike === null) continue; // not a contract without one

      // The midpoint stands in for an untraded contract's price only when
      // there is a real two-sided quote to take a midpoint of. With bid and
      // ask filled in as zero it produced a last price of 0.00, and with one
      // side missing it produced half the other side.
      const last = num(opt.lastPrice)
        ?? (bid !== null && ask !== null ? (bid + ask) / 2 : null);
      if (last === null) continue;

      const cp: 'C' | 'P' = opt.contractSymbol?.includes('C') ? 'C' : 'P';

      const heat = bid !== null && ask !== null && oi !== null
        ? computeHeatScore({ bid, ask, price: last, size, avgVolume: size * 0.3, openInterest: oi })
        : undefined;

      onFlowEvent?.({
        id: `yahoo-${opt.contractSymbol}-${Date.now()}`,
        timestamp: new Date().toISOString(),
        symbol,
        expiration: opt.expiration ? new Date(opt.expiration * 1000).toISOString().split('T')[0] : '',
        strike,
        callPut: cp,
        type: classifySweep({ size, exchanges: ['C'] }),
        size,
        premium: last * size * 100,
        heatScore: heat,
        sentiment: cp === 'C' ? 'bullish' : 'bearish',
        source: 'yahoo',
        bid: orUndefined(bid),
        ask: orUndefined(ask),
        iv: orUndefined(num(opt.impliedVolatility)),
      } as FlowEvent);
    }
  } catch {}
}

export async function startYahoo(): Promise<void> {
  if (!ENABLED) { console.log('[yahoo] Disabled'); return; }

  await fetchQuotes();
  setInterval(fetchQuotes, 30_000).unref();

  // Fetch options for top symbols every 3 min (stagger to avoid rate limiting)
  let idx = 0;
  setInterval(() => {
    const sym = WATCHED[idx % WATCHED.length];
    fetchOptionFlow(sym);
    idx++;
  }, 15_000).unref();

  console.log('[yahoo] Started — quotes every 30s, options chain cycling every 15s per symbol');
}
