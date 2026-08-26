/**
 * Signal kinds emitted by the backend flow engine.
 *  SWEEP     — one order filled across multiple venues (or ISO-flagged)
 *  BLOCK     — a single print clearing the size/premium threshold
 *  SPLIT     — repeated prints on one contract+side inside a rolling window
 *  MULTI_LEG — legs of one structure printing together (see `legs`)
 *  LARGE     — single-venue cluster that still clears the premium threshold
 */
export type OrderType = 'SWEEP' | 'BLOCK' | 'SPLIT' | 'MULTI_LEG' | 'LARGE'

/**
 * Quote-rule side inference. AMBIGUOUS means the NBBO was missing or stale —
 * the engine reports no direction rather than guessing one.
 */
export type InferredSide =
  | 'BUY' | 'SELL' | 'BUY_LEAN' | 'SELL_LEAN' | 'AMBIGUOUS'

export interface FlowEventLeg {
  underlying: string
  expiry: string
  strike: number
  option_type: 'C' | 'P'
  side: InferredSide
  total_size: number
  total_premium: number
  avg_price: number
  prints: number
  exchanges: string[]
}

export interface FlowEvent {
  id: string
  underlying: string
  expiry: string
  strike: number
  option_type: 'C' | 'P'
  order_type: OrderType
  total_size: number
  total_premium: number
  heat_score: number
  sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  is_unusual: boolean
  exchange_count: number
  avg_price: number
  iv: number
  delta: number
  open_interest: number
  days_to_expiry: number
  moneyness: 'ITM' | 'ATM' | 'OTM'
  spot_price: number
  created_at: string
  source: string
  ml_score?: number

  // ── Engine-native fields ──
  side?: InferredSide
  /** Per-component score contributions — why the signal scored what it did. */
  score_breakdown?: Record<string, number>
  /** Present on MULTI_LEG: the full structure. The event is the dominant leg. */
  legs?: FlowEventLeg[]
  spread_guess?: 'VERTICAL' | 'CALENDAR' | 'STRADDLE_STRANGLE' | 'UNKNOWN'
  /** Audit trail: the print ids that formed this signal. */
  print_ids?: string[]
  /** True when the source was simulated, replayed, or chain-derived. */
  synthetic?: boolean
}

export interface DarkPoolPrint {
  id: string
  symbol: string
  price: number
  size: number
  notional: number
  exchange: string
  condition: string
  created_at: string
  is_block: boolean
  repeat_count: number
}

export interface PowerAlert {
  id: string
  underlying: string
  alert_type: 'SWEEP' | 'BLOCK' | 'DARK_POOL' | 'GEX_FLIP' | 'ML_SIGNAL'
  message: string
  heat_score: number
  ml_score: number
  created_at: string
  flow_event_id?: string
}

export interface GEXLevel {
  strike: number
  net_gex: number
  call_gex: number
  put_gex: number
  level_type: 'SUPPORT' | 'RESISTANCE' | 'FLIP'
}

export interface FlowFilters {
  ticker: string
  minPremium: number
  optionType: 'ALL' | 'C' | 'P'
  orderType: 'ALL' | OrderType
  sentiment: 'ALL' | 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  minHeat: number
  unusualOnly: boolean
}

export interface StrategyLeg {
  optionType: 'C' | 'P'
  action: 'BUY' | 'SELL'
  strike: number
  expiry: string
  iv: number
  entryPrice: number
  qty: number
}

export interface BSResult {
  price: number
  delta: number
  gamma: number
  theta: number
  vega: number
  rho: number
}

export interface MarketSnapshot {
  ticker: string
  price: number
  change: number
  changePct: number
}
