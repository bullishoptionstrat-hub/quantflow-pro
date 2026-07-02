export interface StrictHeatScoreInput {
  total_premium: number;
  bid_price: number;
  ask_price: number;
  fill_price: number;
  total_size: number;
  open_interest: number;
  exchange_count: number;
  iv: number;
  days_to_expiry: number;
  order_type: 'SWEEP' | 'BLOCK' | 'SPLIT';
}

export interface LegacyHeatScoreInput {
  bid: number;
  ask: number;
  price: number;
  size: number;
  avgVolume?: number;
  openInterest: number;
  iv?: number;
  daysToExpiry?: number;
  exchangeCount?: number;
  orderType?: 'SWEEP' | 'BLOCK' | 'SPLIT';
}

export type HeatScoreInput = StrictHeatScoreInput | LegacyHeatScoreInput;

function normalizeHeatScoreInput(input: HeatScoreInput): StrictHeatScoreInput {
  if ('total_premium' in input) {
    return input;
  }

  const exchangeCount = input.exchangeCount ?? 1;
  const orderType = input.orderType
    ?? (exchangeCount >= 2 ? 'SWEEP' : input.size >= 500 ? 'BLOCK' : 'SPLIT');

  return {
    total_premium: input.price * input.size * 100,
    bid_price: input.bid,
    ask_price: input.ask,
    fill_price: input.price,
    total_size: input.size,
    open_interest: input.openInterest,
    exchange_count: exchangeCount,
    iv: input.iv ?? 0,
    days_to_expiry: input.daysToExpiry ?? 30,
    order_type: orderType,
  };
}

/**
 * InsiderFinance-style heat score algorithm.
 * Combines bid/ask aggressiveness, size-to-OI, premium magnitude, and sweep classification.
 * Returns 0–100.
 */
export function computeHeatScore(input: HeatScoreInput): number {
  const normalized = normalizeHeatScoreInput(input);
  let score = 0;

  // 1. Bid/Ask displacement (0–35 pts)
  const spread = Math.max(normalized.ask_price - normalized.bid_price, 0.01);
  const midpoint = (normalized.bid_price + normalized.ask_price) / 2;
  const displacement = (normalized.fill_price - midpoint) / spread; // -0.5 to +0.5
  const aggressionScore = Math.max(0, Math.min(35, displacement * 70 + 17.5));
  score += aggressionScore;

  // 2. Premium magnitude (0–25 pts)
  const premiumScore = Math.min(25, (Math.log10(Math.max(normalized.total_premium, 1000)) - 3) * 8.33);
  score += Math.max(0, premiumScore);

  // 3. Size / OI ratio (0–20 pts)
  const sizeOI = normalized.open_interest > 0 ? normalized.total_size / normalized.open_interest : 0;
  const sizeScore = Math.min(20, sizeOI * 200);
  score += sizeScore;

  // 4. Multi-exchange sweep bonus (0–15 pts)
  if (normalized.order_type === 'SWEEP') {
    const exchangeBonus = Math.min(15, (normalized.exchange_count - 1) * 5);
    score += Math.max(0, exchangeBonus);
  }

  // 5. IV context penalty for cheap OTM lotto (max -10 pts)
  if (normalized.iv > 100 && normalized.days_to_expiry < 5) {
    score -= 10;
  }

  return Math.round(Math.max(0, Math.min(100, score)));
}
