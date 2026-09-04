/**
 * MarketData.app — Options chains, quotes, Greeks, IV
 * Free forever: 100 credits/day, 24h delayed on free plan
 * Docs: https://marketdata.app/docs
 */
import axios from 'axios';
import { LegacyFlowEvent as FlowEvent } from '../index';
import { computeHeatScore } from '../heatScore';
import { classifySweep } from '../sweepDetector';
import { num, orUndefined } from '../optionalNumber';

const TOKEN = process.env.MARKETDATA_TOKEN || '';
const BASE = 'https://api.marketdata.app/v1';
const WATCHED = ['SPY', 'QQQ', 'NVDA', 'AAPL', 'TSLA', 'MSFT', 'AMD', 'MSTR'];

/**
 * A row of the chain, carrying only what the response actually held.
 *
 * Every field below `callPut` was `?? 0`. A chain row is mostly optional in
 * practice — an untraded contract has no last, an unquoted one no bid, and
 * the free plan omits greeks it has not computed — so the zeros were not a
 * rare edge. They were the normal shape of a quiet strike, rendered as a
 * reading.
 */
export interface MDOptionQuote {
  symbol: string;
  strike: number;
  expiration: string;
  callPut: 'C' | 'P';
  bid: number | null;
  ask: number | null;
  last: number | null;
  volume: number | null;
  openInterest: number | null;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
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
    // A length, not a reading — an empty chain genuinely has zero rows.
    const count: number = Array.isArray(data.optionSymbol) ? data.optionSymbol.length : 0;

    for (let i = 0; i < count; i++) {
      // A row with no strike or no expiry is not a contract. It cannot be
      // named, priced or classified, and `strike: 0` made it look like one.
      const strike = num(data.strike?.[i]);
      const expiration = data.expiration?.[i];
      if (strike === null || typeof expiration !== 'string' || !expiration) continue;

      quotes.push({
        symbol,
        strike,
        expiration,
        callPut: data.side?.[i] === 'call' ? 'C' : 'P',
        bid: num(data.bid?.[i]),
        ask: num(data.ask?.[i]),
        last: num(data.last?.[i]),
        volume: num(data.volume?.[i]),
        openInterest: num(data.openInterest?.[i]),
        iv: num(data.iv?.[i]),
        delta: num(data.delta?.[i]),
        gamma: num(data.gamma?.[i]),
        theta: num(data.theta?.[i]),
        vega: num(data.vega?.[i]),
      });
    }
    return quotes;
  } catch (err: any) {
    if (err.response?.status === 402) creditsUsed = DAILY_CREDIT_LIMIT;
    return [];
  }
}

export function quotesToFlow(quotes: MDOptionQuote[]): FlowEvent[] {
  return quotes
    // A null fails every one of these comparisons, which is the intent: an
    // unknown volume is not "more than 50", and a row with no last price
    // cannot be given one. Previously each was a zero, so the row was
    // filtered on a value the response never carried.
    // The strike is guarded at the parse above too. Repeated here because
    // this function is the seam that builds the event, and a contract with no
    // strike must not be nameable from either direction.
    .filter(q => Number.isFinite(q.strike))
    .filter(q => q.volume !== null && q.volume > 50
              && q.openInterest !== null && q.openInterest > 0
              && q.last !== null)
    .slice(0, 5)
    .map(q => {
      const size = q.volume as number;
      const last = q.last as number;
      return {
        id: `mkt-${q.symbol}-${q.expiration}-${q.callPut}-${q.strike}-${Date.now()}`,
        timestamp: new Date().toISOString(),
        symbol: q.symbol,
        expiration: q.expiration,
        strike: q.strike,
        callPut: q.callPut,
        type: classifySweep({ size, exchanges: ['C'] }),
        size,
        premium: last * size * 100,
        // Only when the quote is known. The score's largest component is
        // bid/ask displacement, so without an NBBO it is not a weaker score
        // but a different quantity wearing the same name.
        heatScore: heatOrUndefined(q, last, size),
        sentiment: q.callPut === 'C' ? 'bullish' : 'bearish',
        source: 'marketdata.app',
        bid: orUndefined(q.bid),
        ask: orUndefined(q.ask),
        iv: orUndefined(q.iv),
        delta: orUndefined(q.delta),
      } as FlowEvent;
    });
}

function heatOrUndefined(q: MDOptionQuote, price: number, size: number): number | undefined {
  if (q.bid === null || q.ask === null || q.openInterest === null) return undefined;
  return computeHeatScore({
    bid: q.bid, ask: q.ask, price,
    size, avgVolume: size * 0.5, openInterest: q.openInterest,
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
  setInterval(poll, 15 * 60_000).unref(); // every 15 min — preserve credits
  console.log('[marketdata] Started — polling every 15min (100 credits/day)');
}
