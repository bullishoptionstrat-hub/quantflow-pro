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
  /** True when the source was simulated, replayed, or chain-derived. */
  synthetic?: boolean
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

/**
 * `GET /api/macro/quotes` → `{ quotes: SpotQuote[] }`.
 *
 * This replaces `MarketSnapshot`, which nothing imported and which no endpoint
 * has ever sent: it declared `ticker`, and the wire's key is `symbol`. It was
 * a slot waiting for the next reader to bind to it and silently render
 * `undefined` — the same shape of hazard as `PowerAlert.ml_score`.
 *
 * `timestamp` is milliseconds and is the quote's own clock, not receipt time,
 * so a tape can say how old its prices are. See `quoteTimestamp()` in the
 * connector for why that took a fix.
 */
export interface SpotQuote {
  symbol: string
  price: number
  change: number
  changePct: number
  volume: number
  timestamp: number
  source: 'twelvedata'
}

/**
 * `GET /api/sentiment/news/headlines` → `{ headlines: NewsItem[], total }`.
 *
 * One shape whichever connector carried the story. The route used to send
 * NewsAPI's records and FMP's concatenated under this key, and they agree on
 * almost nothing: FMP has `symbol` where NewsAPI has `symbols[]`,
 * `publishedDate` where NewsAPI has `publishedAt`, no id at all, and the
 * literal `'fmp'` in the `source` field where NewsAPI puts the outlet's name.
 *
 * The page's old interface described only the NewsAPI half, so `symbols` was
 * `undefined` on every FMP item and `symbols.length` a TypeError — a page
 * crash waiting on an `FMP_API_KEY`, not on a code change. `publisher` and
 * `provider` are separate fields because the old single `source` meant two
 * different things depending on which half of the array you had read.
 */
export interface NewsItem {
  id: string
  title: string
  url: string
  /** The outlet that ran it. FMP's feed names none, so: null. */
  publisher: string | null
  /** Which connector carried it — whose keyword list produced `sentiment`. */
  provider: 'newsapi' | 'fmp'
  publishedAt: string
  symbols: string[]
  /** Our keyword read of the title, not a stance the outlet took. */
  sentiment: 'bullish' | 'bearish' | 'neutral'
}

/**
 * `GET /api/sentiment` → `{ scores, reddit: RedditSentiment[], newsCount, updatedAt }`.
 *
 * **`sentimentScore` runs -100…+100**, not -1…+1. The page previously declared
 * a `sentiment` field on this record — a name the wire has never carried — and
 * every consumer of it was calibrated for the smaller scale: a gauge computing
 * `((score + 1) / 2) * 100` and labels thresholded at ±0.2. Binding those to
 * the real field without rescaling would have typechecked, rendered a
 * confident colour, and called a score of 30 "VERY BULLISH" at 1550% width.
 *
 * `bullishMentions` / `bearishMentions` are **keyword hits summed over posts**,
 * not counts of posts and not shares of `mentions` — the connector adds a
 * whole post's term hits to both tallies, so they can exceed `mentions` and
 * cannot be turned into percentages of it. `sentimentScore` is already their
 * normalized difference, and is the only ratio here that means anything.
 */
export interface RedditSentiment {
  symbol: string
  mentions: number
  bullishMentions: number
  bearishMentions: number
  /** -100…+100. See the note above before rendering this. */
  sentimentScore: number
  topPosts: { title: string; score: number; url: string }[]
  updatedAt: string
  source: 'reddit'
}

/**
 * `GET /api/sentiment/earnings/calendar` → `{ earnings: EarningsEvent[] }`.
 *
 * FMP's calendar carries no company name and no session marker. The page used
 * to declare both — rendering a `BMO`/`AMC` badge that decided its own colour
 * off an `undefined` — and only ever displayed them from a hardcoded fallback
 * array that supplied what the wire does not.
 *
 * `date` is a calendar date in the issuer's local terms, not an instant.
 */
export interface EarningsEvent {
  symbol: string
  date: string
  /** Reported figures, present only after the release. */
  eps: number | null
  revenue: number | null
  epsEstimated: number | null
  revenueEstimated: number | null
  source: 'fmp'
}
