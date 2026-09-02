/**
 * MarketData.app — Options chains, quotes, Greeks, IV
 * Free forever: 100 credits/day, 24h delayed on free plan
 * Docs: https://marketdata.app/docs
 */
import axios from 'axios';
import { LegacyFlowEvent as FlowEvent } from '../index';
import { computeHeatScore } from '../heatScore';
import { classifySweep } from '../sweepDetector';
import { num } from '../parseNumeric';

const TOKEN = process.env.MARKETDATA_TOKEN || '';
const BASE = 'https://api.marketdata.app/v1';
const WATCHED = ['SPY', 'QQQ', 'NVDA', 'AAPL', 'TSLA', 'MSFT', 'AMD', 'MSTR'];

export interface MDOptionQuote {
  // Identity and price are non-null by construction: `fetchOptionChain` skips
  // any row missing them rather than filling a zero, so a quote that exists
  // here is one that could really be built.
  symbol: string;
  strike: number;
  expiration: string;
  callPut: 'C' | 'P';
  /**
   * `null` when the vendor did not quote that leg — never 0, which is a
   * two-sided market at zero and would be a reading rather than an absence.
   */
  bid: number | null;
  ask: number | null;
  last: number;
  /** Real zeros: no volume and no open interest are both genuine readings. */
  volume: number;
  openInterest: number;
  /** Greeks are measurements. `null` when absent; 0 would assert a value. */
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
    const count = data.optionSymbol?.length ?? 0;

    for (let i = 0; i < count; i++) {
      // Identity first. A row without a strike or an expiry is not a contract,
      // and `?? 0` made it one: `occSymbol()` builds the engine's clustering
      // key from the strike, so every unparsed row became the same fabricated
      // "contract" at strike 0 and was scored as repeat activity on it.
      const strike = num(data.strike?.[i]);
      const expiration = typeof data.expiration?.[i] === 'string' ? data.expiration[i] : '';
      if (strike === null || strike <= 0 || !expiration) continue;

      // Priceable, or it cannot become a print. `last` drives `premium`, and a
      // zero premium is a trade that cost nothing.
      const last = num(data.last?.[i]);
      if (last === null || last <= 0) continue;

      quotes.push({
        symbol,
        strike,
        expiration,
        callPut: data.side?.[i] === 'call' ? 'C' : 'P',
        // The NBBO legs stay nullable rather than zero-filled. A missing quote
        // is not a market at 0.00/0.00, and the adapter already refuses to
        // publish an NBBO unless `ask > 0 && ask >= bid` — so zero-filling only
        // ever produced a quote that was silently discarded one layer later,
        // while looking like data here.
        bid: num(data.bid?.[i]),
        ask: num(data.ask?.[i]),
        last,
        // Genuinely zero-able: no volume and no open interest are real readings,
        // and the caller filters on `volume > 50 && openInterest > 0` anyway.
        volume: num(data.volume?.[i]) ?? 0,
        openInterest: num(data.openInterest?.[i]) ?? 0,
        // Greeks are measurements, not defaults. `iv: 0` is an assertion that
        // the option has no implied volatility, which is not a thing.
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

function quotesToFlow(quotes: MDOptionQuote[]): FlowEvent[] {
  return quotes
    .filter(q => q.volume > 50 && q.openInterest > 0)
    .slice(0, 5)
    .map(q => {
      // `heatScore` is superseded by the flow engine and the adapter discards
      // this value, but it is still computed here, so it must not be fed
      // fabricated legs. Without a two-sided quote there is no spread and no
      // displacement to measure; `?? q.last` uses the trade's own price, which
      // yields zero displacement — the neutral answer — rather than pretending
      // the market was 0.00 bid at 0.00 offered.
      const heat = computeHeatScore({
        bid: q.bid ?? q.last, ask: q.ask ?? q.last, price: q.last,
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
        // null -> undefined at the wire boundary. `LegacyFlowEvent` declares
        // these optional, so absence stays absence; it must not become 0.
        bid: q.bid ?? undefined, ask: q.ask ?? undefined,
        iv: q.iv ?? undefined, delta: q.delta ?? undefined,
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
