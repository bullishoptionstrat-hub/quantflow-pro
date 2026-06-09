export interface HeatScoreInput {
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

/**
 * InsiderFinance-style heat score algorithm.
 * Combines bid/ask aggressiveness, size-to-OI, premium magnitude, and sweep classification.
 * Returns 0–100.
 */
export function computeHeatScore(input: HeatScoreInput): number {
  let score = 0;

  // 1. Bid/Ask displacement (0–35 pts)
  const spread = Math.max(input.ask_price - input.bid_price, 0.01);
  const midpoint = (input.bid_price + input.ask_price) / 2;
  const displacement = (input.fill_price - midpoint) / spread; // -0.5 to +0.5
  const aggressionScore = Math.max(0, Math.min(35, displacement * 70 + 17.5));
  score += aggressionScore;

  // 2. Premium magnitude (0–25 pts)
  const premiumScore = Math.min(25, (Math.log10(Math.max(input.total_premium, 1000)) - 3) * 8.33);
  score += Math.max(0, premiumScore);

  // 3. Size / OI ratio (0–20 pts)
  const sizeOI = input.open_interest > 0 ? input.total_size / input.open_interest : 0;
  const sizeScore = Math.min(20, sizeOI * 200);
  score += sizeScore;

  // 4. Multi-exchange sweep bonus (0–15 pts)
  if (input.order_type === 'SWEEP') {
    const exchangeBonus = Math.min(15, (input.exchange_count - 1) * 5);
    score += Math.max(0, exchangeBonus);
  }

  // 5. IV context penalty for cheap OTM lotto (max -10 pts)
  if (input.iv > 100 && input.days_to_expiry < 5) {
    score -= 10;
  }

  return Math.round(Math.max(0, Math.min(100, score)));
}
