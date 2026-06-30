/**
 * FlashAlpha — Pre-computed GEX/DEX/VEX, gamma flip, max pain
 * Free tier: 5 req/day, no card required
 * Docs: https://flashalpha.com/api-documentation
 */
import axios from 'axios';

const API_KEY = process.env.FLASHALPHA_API_KEY || '';
const BASE = 'https://lab.flashalpha.com';
const SYMBOLS = ['SPX', 'SPY', 'QQQ', 'NVDA', 'AAPL', 'TSLA', 'MSFT'];

export interface FlashGEXLevel {
  strike: number;
  gex: number;
  dex: number;
  vex: number;
  callGamma: number;
  putGamma: number;
  source: 'flashalpha';
}

export interface FlashGEXSummary {
  symbol: string;
  gammaFlip: number;
  maxPain: number;
  callWall: number;
  putWall: number;
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

    const levels: FlashGEXLevel[] = (data.strikes ?? []).map((s: any) => ({
      strike: s.strike,
      gex: s.net_gex ?? 0,
      dex: s.net_dex ?? 0,
      vex: s.net_vex ?? 0,
      callGamma: s.call_gamma ?? 0,
      putGamma: s.put_gamma ?? 0,
      source: 'flashalpha' as const,
    }));

    cache.set(symbol, {
      symbol,
      gammaFlip: data.gamma_flip ?? 0,
      maxPain: data.max_pain ?? 0,
      callWall: data.call_wall ?? 0,
      putWall: data.put_wall ?? 0,
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
