export interface HeatScoreInput {
  total_premium?: number;
  bid_price?: number;
  ask_price?: number;
  fill_price?: number;
  total_size?: number;
  open_interest?: number;
  exchange_count?: number;
  iv?: number;
  days_to_expiry?: number;
  order_type?: 'SWEEP' | 'BLOCK' | 'SPLIT';
  bid?: number;
  ask?: number;
  price?: number;
  size?: number;
  avgVolume?: number;
  openInterest?: number;
}

/**
 * InsiderFinance-style heat score algorithm.
 * Combines bid/ask aggressiveness, size-to-OI, premium magnitude, and sweep classification.
 * Returns 0–100.
 */
export function computeHeatScore(input: HeatScoreInput): number {
  const bidPrice = input.bid_price ?? input.bid ?? 0;
  const askPrice = input.ask_price ?? input.ask ?? bidPrice;
  const fillPrice = input.fill_price ?? input.price ?? askPrice;
  const totalSize = input.total_size ?? input.size ?? 0;
  const totalPremium = input.total_premium ?? fillPrice * totalSize * 100;
  const openInterest = input.open_interest ?? input.openInterest ?? 0;
  const exchangeCount = input.exchange_count ?? 1;
  const iv = input.iv ?? 0;
  const daysToExpiry = input.days_to_expiry ?? 30;
  const orderType = input.order_type ?? 'BLOCK';
  let score = 0;

  // 1. Bid/Ask displacement (0–35 pts)
  const spread = Math.max(askPrice - bidPrice, 0.01);
  const midpoint = (bidPrice + askPrice) / 2;
  const displacement = (fillPrice - midpoint) / spread; // -0.5 to +0.5
  const aggressionScore = Math.max(0, Math.min(35, displacement * 70 + 17.5));
  score += aggressionScore;

  // 2. Premium magnitude (0–25 pts)
  const premiumScore = Math.min(25, (Math.log10(Math.max(totalPremium, 1000)) - 3) * 8.33);
  score += Math.max(0, premiumScore);

  // 3. Size / OI ratio (0–20 pts)
  const sizeOI = openInterest > 0 ? totalSize / openInterest : 0;
  const sizeScore = Math.min(20, sizeOI * 200);
  score += sizeScore;

  // 4. Multi-exchange sweep bonus (0–15 pts)
  if (orderType === 'SWEEP') {
    const exchangeBonus = Math.min(15, (exchangeCount - 1) * 5);
    score += Math.max(0, exchangeBonus);
  }

  // 5. IV context penalty for cheap OTM lotto (max -10 pts)
  if (iv > 100 && daysToExpiry < 5) {
    score -= 10;
  }

  return Math.round(Math.max(0, Math.min(100, score)));
}
