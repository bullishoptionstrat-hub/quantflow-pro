/**
 * QuantFlow Flow Engine — core types
 *
 * Provider-agnostic. Any feed (Polygon WS, Polygon REST replay, synthetic
 * fixtures) is normalized into OptionTradeEvent / OptionQuoteEvent before
 * entering the engine. All timestamps are epoch MILLISECONDS (number).
 */

export type OptionRight = "C" | "P";

export type InferredSide =
  | "BUY"        // at/above ask
  | "SELL"       // at/below bid
  | "BUY_LEAN"   // above mid, inside spread
  | "SELL_LEAN"  // below mid, inside spread
  | "AMBIGUOUS"  // at mid, or no NBBO available
  ;

export type SignalKind = "SWEEP" | "BLOCK" | "SPLIT" | "MULTI_LEG" | "LARGE";

export interface OptionContract {
  /** OCC-style symbol, e.g. "SPY260619C00550000" */
  symbol: string;
  underlying: string;        // "SPY"
  right: OptionRight;
  strike: number;            // 550
  expiry: string;            // "2026-06-19" (ISO date)
}

export interface OptionTradeEvent {
  id: string;                // provider trade id (or synthetic id)
  ts: number;                // epoch ms
  contract: OptionContract;
  price: number;             // per-contract premium
  size: number;              // contracts
  exchange: string;          // e.g. "CBOE", "PHLX", "AMEX"
  conditions: number[];      // raw provider condition codes
  /** True when provider marks an Intermarket Sweep Order condition. */
  iso?: boolean;
}

export interface OptionQuoteEvent {
  ts: number;
  contractSymbol: string;
  bid: number;
  ask: number;
}

/** Optional per-contract context for scoring (from chain snapshot). */
export interface ContractStats {
  openInterest?: number;
  /** 20-day average contract volume; used for relative-volume scoring. */
  avgDailyVolume?: number;
  /** Day volume BEFORE this signal's contracts (for vol>OI logic). */
  dayVolume?: number;
  /** Underlying spot at time of trade (for OTM% / DTE scoring). */
  underlyingPrice?: number;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface SignalLeg {
  contract: OptionContract;
  side: InferredSide;
  totalSize: number;
  totalPremium: number;      // dollars: Σ price * size * 100
  vwap: number;
  prints: number;
  exchanges: string[];
}

export interface ClassifiedSignal {
  id: string;
  kind: SignalKind;
  ts: number;                       // ts of first print in the cluster
  underlying: string;
  side: InferredSide;               // dominant side (legs may differ)
  legs: SignalLeg[];                // 1 leg unless MULTI_LEG
  totalPremium: number;
  totalSize: number;
  iso: boolean;
  /** Rule-based unusualness score 0–100. Deterministic, explainable. */
  score: number;
  scoreBreakdown: Record<string, number>;
  /** For MULTI_LEG: best-effort structure guess. Never a trade trigger. */
  spreadGuess?: "VERTICAL" | "CALENDAR" | "STRADDLE_STRANGLE" | "UNKNOWN";
  /** Audit trail: every print id that formed this signal. */
  printIds: string[];
  /** True when the feeding source is synthetic/replay — must surface in UI. */
  synthetic: boolean;
}

// ---------------------------------------------------------------------------
// Engine config
// ---------------------------------------------------------------------------

export interface FlowEngineConfig {
  /** Trades on same contract+side within this window cluster into one event. */
  sweepWindowMs: number;            // default 100
  /** Trades on same underlying, different contracts, within this window = legs. */
  multiLegWindowMs: number;         // default 25
  /** Minimum cluster premium ($) to emit any signal. */
  minSignalPremium: number;         // default 25_000
  /** Single print at/above this size is a BLOCK. */
  blockMinSize: number;             // default 100
  /** Single print at/above this premium is a BLOCK regardless of size. */
  blockMinPremium: number;          // default 100_000
  /** SPLIT: ≥ this many prints, same contract+side, inside splitWindowMs. */
  splitMinPrints: number;           // default 5
  splitWindowMs: number;            // default 5 * 60_000
  splitMinPremium: number;          // default 50_000
  /** NBBO staleness: quotes older than this (ms) are unusable for side. */
  nbboMaxAgeMs: number;             // default 2_000
  /** Mark every emitted signal as synthetic (replay/fixture mode). */
  syntheticSource: boolean;
}

export const DEFAULT_CONFIG: FlowEngineConfig = {
  sweepWindowMs: 100,
  multiLegWindowMs: 25,
  minSignalPremium: 25_000,
  blockMinSize: 100,
  blockMinPremium: 100_000,
  splitMinPrints: 5,
  splitWindowMs: 5 * 60_000,
  splitMinPremium: 50_000,
  nbboMaxAgeMs: 2_000,
  syntheticSource: false,
};

export function premiumOf(price: number, size: number): number {
  return price * size * 100;
}
