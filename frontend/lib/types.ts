export interface FlowEvent {
  id: string
  underlying: string
  expiry: string
  strike: number
  option_type: 'C' | 'P'
  order_type: 'SWEEP' | 'BLOCK' | 'SPLIT'
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
  orderType: 'ALL' | 'SWEEP' | 'BLOCK' | 'SPLIT'
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
