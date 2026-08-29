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
  ts: number;                // epoch ms — when the trade happened (event time)
  contract: OptionContract;
  price: number;             // per-contract premium
  size: number;              // contracts
  exchange: string;          // e.g. "CBOE", "PHLX", "AMEX"
  conditions: number[];      // raw provider condition codes
  /** True when provider marks an Intermarket Sweep Order condition. */
  iso?: boolean;
  /**
   * Wall clock (epoch ms) when this print reached us — distinct from `ts`,
   * which is when it happened at the venue. The gap between them is feed
   * latency, and it is the difference between a signal being *formed* and a
   * signal being *knowable*. Omitted by replay adapters, where wall clock
   * carries no information about the historical moment.
   */
  receivedAt?: number;
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
  /**
   * ts of the FIRST print in the cluster.
   *
   * DEPRECATED for research windows. A signal assembled from a 500 ms burst
   * was not actionable at the burst's first tick; measuring from here grants
   * a backtest that 500 ms of free information and makes every excursion look
   * better than it was. Kept because the wire contract and the UI use it as a
   * display timestamp. For any measurement, use the consumer's own decision
   * timestamp instead — in this repo's backend that is `decisionAt`, built in
   * persistence/identity.ts.
   */
  ts: number;
  /** ts of the LAST print in the cluster — when the cluster was complete. */
  lastTs: number;
  /**
   * Max wall-clock receipt time across the forming prints, when every print
   * carried one. `undefined` when any print lacked it (replay), which is a
   * different fact from "arrived instantly" and is preserved as such.
   */
  receivedAt?: number;
  /** Wall clock at the moment the engine finalized this signal. */
  emittedAt: number;
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
