/**
 * MarketData.app — Options chains, quotes, Greeks, IV
 * Free forever: 100 credits/day, 24h delayed on free plan
 * Docs: https://marketdata.app/docs
 */
import axios from 'axios';
import { FlowEvent } from '../index';
import { computeHeatScore } from '../heatScore';
import { classifySweep } from '../sweepDetector';

const TOKEN = process.env.MARKETDATA_TOKEN || '';
const BASE = 'https://api.marketdata.app/v1';
const WATCHED = ['SPY', 'QQQ', 'NVDA', 'AAPL', 'TSLA', 'MSFT', 'AMD', 'MSTR'];

export interface MDOptionQuote {
  symbol: string;
  strike: number;
  expiration: string;
  callPut: 'C' | 'P';
  bid: number;
  ask: number;
  last: number;
  volume: number;
  openInterest: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

let onFlowEvent: ((e: FlowEvent) => void) | null = null;
let creditsUsed = 0;
const DAILY_CREDIT_LIMIT = 90; // leave 10 in reserve

export function onMarketDataFlow(handler: (e: FlowEvent) => void): void {
  onFlowEvent = handler;
}

async function fetchOptionChain(symbol: string): Promise<MDOptionQuote[]> {
  if (creditsUsed >= DAILY_CREDIT_LIMIT) return [];
  try {
    creditsUsed++;
    const { data } = await axios.get(`${BASE}/options/chain/${symbol}/`, {
      headers: { Authorization: `Token ${TOKEN}` },
      params: { dte: '1-60', strikeLimit: 10 },
      timeout: 10000,
    });

    if (!data?.s || data.s !== 'ok') return [];

    const quotes: MDOptionQuote[] = [];
    const count = data.optionSymbol?.length ?? 0;

    for (let i = 0; i < count; i++) {
      quotes.push({
        symbol,
        strike: data.strike?.[i] ?? 0,
        expiration: data.expiration?.[i] ?? '',
        callPut: data.side?.[i] === 'call' ? 'C' : 'P',
        bid: data.bid?.[i] ?? 0,
        ask: data.ask?.[i] ?? 0,
        last: data.last?.[i] ?? 0,
        volume: data.volume?.[i] ?? 0,
        openInterest: data.openInterest?.[i] ?? 0,
        iv: data.iv?.[i] ?? 0,
        delta: data.delta?.[i] ?? 0,
        gamma: data.gamma?.[i] ?? 0,
        theta: data.theta?.[i] ?? 0,
        vega: data.vega?.[i] ?? 0,
      });
    }
    return quotes;
  } catch (err: any) {
    if (err.response?.status === 402) creditsUsed = DAILY_CREDIT_LIMIT;
    return [];
  }
}

function quotesToFlow(quotes: MDOptionQuote[]): FlowEvent[] {
  return quotes
    .filter(q => q.volume > 50 && q.openInterest > 0)
    .slice(0, 5)
    .map(q => {
      const heat = computeHeatScore({
        bid: q.bid, ask: q.ask, price: q.last,
        size: q.volume, avgVolume: q.volume * 0.5, openInterest: q.openInterest,
      });
      return {
        id: `mkt-${q.symbol}-${q.expiration}-${q.callPut}-${q.strike}-${Date.now()}`,
        timestamp: new Date().toISOString(),
        symbol: q.symbol,
        expiration: q.expiration,
        strike: q.strike,
        callPut: q.callPut,
        type: classifySweep({ size: q.volume, exchanges: ['C'] }),
        size: q.volume,
        premium: q.last * q.volume * 100,
        heatScore: heat,
        sentiment: q.callPut === 'C' ? 'bullish' : 'bearish',
        source: 'marketdata.app',
        bid: q.bid, ask: q.ask, iv: q.iv, delta: q.delta,
      } as FlowEvent;
    });
}

export async function startMarketData(): Promise<void> {
  if (!TOKEN) { console.log('[marketdata] No token — skipped'); return; }

  // Reset daily counter at midnight
  const now = new Date();
  const msUntilMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();
  setTimeout(() => { creditsUsed = 0; }, msUntilMidnight);

  async function poll(): Promise<void> {
    for (const sym of WATCHED) {
      if (creditsUsed >= DAILY_CREDIT_LIMIT) break;
      const quotes = await fetchOptionChain(sym);
      const events = quotesToFlow(quotes);
      events.forEach(e => onFlowEvent?.(e));
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  await poll();
  setInterval(poll, 15 * 60_000); // every 15 min — preserve credits
  console.log('[marketdata] Started — polling every 15min (100 credits/day)');
}
