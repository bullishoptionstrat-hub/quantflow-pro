/**
 * QuantFlow Outcome Tracker — types
 *
 * Purpose: grade every emitted flow signal at fixed horizons after the alert.
 * This produces (a) a public, honest hit-rate per signal type — the
 * differentiator no competitor ships — and (b) the labeled dataset that is
 * the only legitimate basis for a future predictive scorer.
 *
 * Grading is descriptive measurement, never a trade recommendation.
 */
import { ClassifiedSignal, OptionRight } from "../types.js";

export type CheckpointKey = "M15" | "H1" | "D1" | "EXPIRY";

export const CHECKPOINT_OFFSETS_MS: Record<Exclude<CheckpointKey, "EXPIRY">, number> = {
  M15: 15 * 60_000,
  H1: 60 * 60_000,
  D1: 24 * 60 * 60_000,
};

/** Marks captured at registration and at each checkpoint. */
export interface MarkSnapshot {
  ts: number;
  /** Mid/mark of the dominant contract. undefined = unavailable at that time. */
  contractMark?: number;
  underlyingPrice?: number;
}

export interface CheckpointResult {
  key: CheckpointKey;
  dueTs: number;
  snapshot?: MarkSnapshot;          // set once evaluated
  contractReturnPct?: number;       // (mark - entryMark) / entryMark
  underlyingMovePct?: number;       // (px - entryPx) / entryPx
}

export type ImpliedDirection = "BULLISH" | "BEARISH" | "NONE";

export type OutcomeLabel =
  | "POSITIVE"     // max contract return ≥ +winThresholdPct within horizon
  | "NEGATIVE"     // min contract return ≤ -lossThresholdPct and never positive
  | "NEUTRAL"      // neither threshold reached
  | "UNGRADED";    // ambiguous side or no usable marks — never guessed

export interface TrackedSignal {
  signalId: string;
  signal: ClassifiedSignal;
  impliedDirection: ImpliedDirection;
  entry: MarkSnapshot;
  checkpoints: CheckpointResult[];
  /** Set when all checkpoints evaluated (or horizon abandoned). */
  finalLabel?: OutcomeLabel;
  directionCorrectAtD1?: boolean;
  closedAt?: number;
}

export interface OutcomeTrackerConfig {
  winThresholdPct: number;   // default 0.25  (+25% on contract mark)
  lossThresholdPct: number;  // default 0.25  (−25% on contract mark)
  /** Skip EXPIRY checkpoint when expiry is further out than this (ms). */
  maxExpiryHorizonMs: number; // default 14 days
}

export const DEFAULT_OUTCOME_CONFIG: OutcomeTrackerConfig = {
  winThresholdPct: 0.25,
  lossThresholdPct: 0.25,
  maxExpiryHorizonMs: 14 * 24 * 60 * 60_000,
};

/**
 * Async price source — provider-agnostic. Return undefined fields when a
 * mark is unavailable; the tracker records the gap instead of inventing one.
 */
export type PriceLookup = (args: {
  contractSymbol: string;
  underlying: string;
  ts: number;
}) => Promise<{ contractMark?: number; underlyingPrice?: number }>;

/** Persistence boundary — implement with Supabase in production. */
export interface OutcomeStore {
  upsert(t: TrackedSignal): Promise<void>;
  listOpen(): Promise<TrackedSignal[]>;
}

export class InMemoryOutcomeStore implements OutcomeStore {
  private readonly m = new Map<string, TrackedSignal>();
  async upsert(t: TrackedSignal): Promise<void> { this.m.set(t.signalId, t); }
  async listOpen(): Promise<TrackedSignal[]> {
    return [...this.m.values()].filter((t) => t.finalLabel === undefined);
  }
  async all(): Promise<TrackedSignal[]> { return [...this.m.values()]; }
}

export function impliedDirectionOf(
  side: ClassifiedSignal["side"],
  right: OptionRight,
): ImpliedDirection {
  const buy = side === "BUY" || side === "BUY_LEAN";
  const sell = side === "SELL" || side === "SELL_LEAN";
  if (!buy && !sell) return "NONE";
  if (right === "C") return buy ? "BULLISH" : "BEARISH";
  return buy ? "BEARISH" : "BULLISH";
}
