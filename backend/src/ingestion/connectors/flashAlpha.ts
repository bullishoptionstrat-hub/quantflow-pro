/**
 * FlashAlpha — Pre-computed GEX/DEX/VEX, gamma flip, max pain
 * Free tier: 5 req/day, no card required
 * Docs: https://flashalpha.com/api-documentation
 */
import axios from 'axios';
import { scheduleDailyReset } from '../dailyReset';
import { num } from '../optionalNumber';

const API_KEY = process.env.FLASHALPHA_API_KEY || '';
const BASE = 'https://lab.flashalpha.com';
const SYMBOLS = ['SPX', 'SPY', 'QQQ', 'NVDA', 'AAPL', 'TSLA', 'MSFT'];

export interface FlashGEXLevel {
  strike: number;
  gex: number | null;
  dex: number | null;
  vex: number | null;
  callGamma: number | null;
  putGamma: number | null;
  source: 'flashalpha';
}

/**
 * Every level in this summary is a **strike price**, and each was `?? 0`.
 *
 * A gamma flip of `0` is not a weak reading, it is a level that cannot exist:
 * dealer positioning does not turn over at a strike of zero on any underlying.
 * Drawn on a chart beside a real one it is indistinguishable — which is the
 * finding this repo already recorded about `/api/gex`, in its own words: *"a
 * fabricated gamma flip looks exactly like a real one."*
 *
 * `dealerRegime` was `data.dealer_regime ?? 'neutral'`, which is the same
 * defect in a string: "dealers are neutrally positioned" is a market read, and
 * a response that carried no regime did not make it. Null is the fourth state,
 * the way `moneyness` gained `UNKNOWN`.
 */
export interface FlashGEXSummary {
  symbol: string;
  gammaFlip: number | null;
  maxPain: number | null;
  callWall: number | null;
  putWall: number | null;
  dealerRegime: 'long' | 'short' | 'neutral' | null;
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

    // A level with no strike is not a level — it cannot be placed on a chart
    // or compared to spot — so the row is dropped rather than defaulted.
    const levels: FlashGEXLevel[] = (data.strikes ?? []).flatMap((s: any) => {
      const strike = num(s.strike);
      if (strike === null || strike <= 0) return [];
      return [{
        strike,
        gex: num(s.net_gex),
        dex: num(s.net_dex),
        vex: num(s.net_vex),
        callGamma: num(s.call_gamma),
        putGamma: num(s.put_gamma),
        source: 'flashalpha' as const,
      }];
    });

    const regime = data.dealer_regime;
    cache.set(symbol, {
      symbol,
      gammaFlip: num(data.gamma_flip),
      maxPain: num(data.max_pain),
      callWall: num(data.call_wall),
      putWall: num(data.put_wall),
      dealerRegime: regime === 'long' || regime === 'short' || regime === 'neutral' ? regime : null,
      levels,
      fetchedAt: Date.now(),
    });

    const flip = num(data.gamma_flip);
    console.log(`[flashalpha] GEX fetched for ${symbol} — flip: ${flip ?? 'not reported'}`);
  } catch (err: any) {
    if (err.response?.status === 429) {
      console.warn('[flashalpha] Daily limit reached');
      dailyCallCount = MAX_DAILY;
    } else {
      console.error('[flashalpha] error:', err.message);
    }
  }
}

/**
 * Spend the day's budget, staggered 90s apart across symbols.
 *
 * This ran once, from `startFlashAlpha`, and nothing ever called it again —
 * FlashAlpha has no recurring poller. So its GEX was fetched once per process
 * lifetime and then aged indefinitely while the source reported `connected`.
 * The daily counter reset that sits beside it only makes sense if the budget
 * is spent again, so the reset now drives this.
 */
function fetchDailyBatch(): void {
  for (let i = 0; i < Math.min(SYMBOLS.length, MAX_DAILY); i++) {
    setTimeout(() => fetchGEX(SYMBOLS[i]), i * 90_000).unref();
  }
}

export async function startFlashAlpha(): Promise<void> {
  if (!API_KEY) { console.log('[flashalpha] No key — skipped'); return; }

  scheduleDailyReset(() => { dailyCallCount = 0; fetchDailyBatch(); });

  fetchDailyBatch();

  console.log('[flashalpha] Started — fetching GEX for top symbols (5/day limit)');
}
