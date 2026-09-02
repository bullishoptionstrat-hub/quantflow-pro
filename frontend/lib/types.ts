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

  // ── Engine-native fields ──
  side?: InferredSide
  /** Per-component score contributions — why the signal scored what it did. */
  score_breakdown?: Record<string, number>
  /** Present on MULTI_LEG: the full structure. The event is the dominant leg. */
  legs?: FlowEventLeg[]
  spread_guess?: 'VERTICAL' | 'CALENDAR' | 'STRADDLE_STRANGLE' | 'UNKNOWN'
  /** Audit trail: the print ids that formed this signal. */
  print_ids?: string[]
  /**
   * @deprecated one-wave alias for `provenance.is_synthetic`.
   * Typed `boolean` rather than `true`-only because the engine really does emit
   * `false` (backend/src/flow-engine/types.ts). Consumers must still test
   * `=== true`: a `false` here is NOT a claim that the data is real, it only
   * says this flag was set. `provenance` is the authoritative field.
   */
  synthetic?: boolean
  /** Truth Firewall envelope — see lib/provenance.ts */
  provenance?: import('./provenance').Provenance
}

/**
 * `GET /api/darkpool` → `data[]`. The wire shape, not a convenient one.
 *
 * This declared `created_at`, `condition`, `is_block` and `repeat_count`, none
 * of which the backend sends — it sends `timestamp` and `source`. The type was
 * satisfied by `generateDarkPool()`, a client-side fabricator, so nothing ever
 * compared it against the API. Wiring the fetch without fixing this would have
 * rendered `undefined` down the whole table, the same way `StooqQuote` would
 * have thrown on `q.price.toFixed(2)`.
 */
export interface DarkPoolPrint {
  id: string
  symbol: string
  price: number
  size: number
  notional: number
  exchange: string
  timestamp: string
  /** `'simulation'` when the print came from the backend's generator. */
  source: string
}

/** `GET /api/darkpool` — the envelope, whose notices the page must render. */
export interface DarkPoolResponse {
  data: DarkPoolPrint[]
  total: number
  notice: string
  disclaimer: string
}

export interface PowerAlert {
  id: string
  underlying: string
  alert_type: 'SWEEP' | 'BLOCK' | 'DARK_POOL' | 'GEX_FLIP' | 'ML_SIGNAL'
  message: string
  heat_score: number
  created_at: string
  flow_event_id?: string
}

/**
 * `GET /api/gex` → `levels[]`.
 *
 * `net_gex`/`call_gex`/`put_gex`/`level_type` were the old client-side shape.
 * The backend sends `gex` plus the open interest and per-side gamma it was
 * computed from, and it does not label a strike SUPPORT or RESISTANCE — the
 * chart made that up with `Math.random() > 0.5`.
 */
export interface GEXLevel {
  strike: number
  gex: number
  callOI: number
  putOI: number
  callGamma: number
  putGamma: number
}

/** `GET /api/gex` — the envelope. `realData` is the field that matters. */
export interface GEXResponse {
  symbol: string
  levels: GEXLevel[]
  flipStrike: number | null
  keyLevels: {
    maxGEXStrike: number | null
    maxGEX: number | null
    minGEXStrike: number | null
    minGEX: number | null
  }
  updatedAt: string
  /** `'cboe'` for a real delayed chain, `'synthetic'` for the fallback. */
  source: 'cboe' | 'synthetic' | string
  /**
   * Whether these levels came from a real chain. The route's own comment:
   * "The UI must be able to tell them apart — a fabricated gamma flip looks
   * exactly like a real one."
   */
  realData: boolean
  realtime: boolean
  delayedMinutes: number | null
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
