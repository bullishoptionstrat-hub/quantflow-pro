/**
 * FlashAlpha — Pre-computed GEX/DEX/VEX, gamma flip, max pain
 * Free tier: 5 req/day, no card required
 * Docs: https://flashalpha.com/api-documentation
 */
import axios from 'axios';
import { num } from '../parseNumeric';

const API_KEY = process.env.FLASHALPHA_API_KEY || '';
const BASE = 'https://lab.flashalpha.com';
const SYMBOLS = ['SPX', 'SPY', 'QQQ', 'NVDA', 'AAPL', 'TSLA', 'MSFT'];

export interface FlashGEXLevel {
  /** Non-null: a level without a strike is not a level, and is dropped. */
  strike: number;
  /**
   * `null` when the vendor did not report the exposure — never 0. Zero net
   * gamma at a strike is a real and meaningful reading (it is what a gamma
   * flip looks like), so the sentinel made "no data" indistinguishable from
   * the single most significant value on the curve.
   */
  gex: number | null;
  dex: number | null;
  vex: number | null;
  callGamma: number | null;
  putGamma: number | null;
  source: 'flashalpha';
}

export interface FlashGEXSummary {
  symbol: string;
  /**
   * `null` when absent — never 0. These are strike prices: a gamma flip or a
   * call wall "at 0" is not a level anyone can act on, and plotting it puts a
   * fabricated line on the chart at the bottom of the axis.
   */
  gammaFlip: number | null;
  maxPain: number | null;
  callWall: number | null;
  putWall: number | null;
  dealerRegime: 'long' | 'short' | 'neutral';
  levels: FlashGEXLevel[];
  fetchedAt: number;
}

const cache = new Map<string, FlashGEXSummary>();
let dailyCallCount = 0;
const MAX_DAILY = 5;

export function getFlashGEX(symbol: string): FlashGEXSummary | null {
  return cache.get(symbol) ?? null;
}

async function fetchGEX(symbol: string): Promise<void> {
  if (dailyCallCount >= MAX_DAILY) return;
  try {
    dailyCallCount++;
    const { data } = await axios.get(`${BASE}/gex/${symbol}`, {
      headers: { 'x-api-key': API_KEY },
      timeout: 8000,
    });

    const levels: FlashGEXLevel[] = (data.strikes ?? [])
      .map((s: any) => {
        // A level needs a strike to be a level. Rows without one are dropped
        // rather than collapsed onto strike 0, where they would stack into a
        // single fabricated level at the bottom of the chart.
        const strike = num(s.strike);
        if (strike === null || strike <= 0) return null;
        return {
          strike,
          gex: num(s.net_gex),
          dex: num(s.net_dex),
          vex: num(s.net_vex),
          callGamma: num(s.call_gamma),
          putGamma: num(s.put_gamma),
          source: 'flashalpha' as const,
        };
      })
      .filter((l: FlashGEXLevel | null): l is FlashGEXLevel => l !== null);

    cache.set(symbol, {
      symbol,
      gammaFlip: num(data.gamma_flip),
      maxPain: num(data.max_pain),
      callWall: num(data.call_wall),
      putWall: num(data.put_wall),
      dealerRegime: data.dealer_regime ?? 'neutral',
      levels,
      fetchedAt: Date.now(),
    });

    console.log(`[flashalpha] GEX fetched for ${symbol} — flip: ${data.gamma_flip}`);
  } catch (err: any) {
    if (err.response?.status === 429) {
      console.warn('[flashalpha] Daily limit reached');
      dailyCallCount = MAX_DAILY;
    } else {
      console.error('[flashalpha] error:', err.message);
    }
  }
}

export async function startFlashAlpha(): Promise<void> {
  if (!API_KEY) { console.log('[flashalpha] No key — skipped'); return; }

  // Reset daily counter at midnight ET
  const now = new Date();
  const msUntilMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();
  setTimeout(() => { dailyCallCount = 0; }, msUntilMidnight);

  // Stagger fetches 90 seconds apart to preserve the 5/day budget across symbols
  for (let i = 0; i < Math.min(SYMBOLS.length, MAX_DAILY); i++) {
    setTimeout(() => fetchGEX(SYMBOLS[i]), i * 90_000);
  }

  console.log('[flashalpha] Started — fetching GEX for top symbols (5/day limit)');
}
