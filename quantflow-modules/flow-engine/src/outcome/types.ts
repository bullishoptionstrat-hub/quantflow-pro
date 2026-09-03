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

/**
 * How the measurement origin was arrived at, recorded per signal.
 *
 * A mixed store is worthless without it: an `EVENT_TIME_ONLY` row credits the
 * pipeline zero latency, which is a lower bound, and pooling those with
 * observed ones flatters every rate they appear in.
 */
export type DecisionBasis =
  /** Both a receipt and an emission clock were present. The origin is observed. */
  | "OBSERVED"
  /** Replay, or a feed supplying no receipt time. The origin is a lower bound. */
  | "EVENT_TIME_ONLY";

export interface DecisionTime {
  at: number;
  basis: DecisionBasis;
}

export interface TrackedSignal {
  signalId: string;
  signal: ClassifiedSignal;
  impliedDirection: ImpliedDirection;
  /** When the signal became actionable — the origin every horizon runs from. */
  decision: DecisionTime;
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

/**
 * The leg the signal is *about*, and the one its `side` was taken from.
 *
 * `buildSignal` sets `ClassifiedSignal.side` from the highest-premium leg, but
 * stores `legs` in the order their contract+side groups were first seen. The
 * tracker read `legs[0]` and paired it with `signal.side` — so on a MULTI_LEG
 * whose small leg printed first, the two describe different contracts.
 *
 * A bought $102k SPY call alongside a $2.2k put — a bullish risk reversal —
 * graded as **BEARISH**, because the put arrived five milliseconds earlier.
 * Single-leg signals are unaffected, which is why this survived: it is only
 * wrong on the structures where direction is hardest to read by eye.
 */
export function dominantLegOf(signal: ClassifiedSignal) {
  let best = signal.legs[0];
  for (const leg of signal.legs) {
    if (best === undefined || leg.totalPremium > best.totalPremium) best = leg;
  }
  return best;
}

/**
 * When the signal became actionable, which is not when its first print landed.
 *
 * The tracker took its entry marks at `signal.ts` and scheduled every
 * checkpoint from it. `ts` is the **first** print in the cluster: a signal
 * assembled from a 500ms burst was not actionable at that burst's first tick,
 * so measuring from there hands the horizon the burst duration plus the feed
 * latency as free information, and every excursion comes out flattering.
 *
 * `max(lastTs, receivedAt, emittedAt)` is the same rule the production
 * recorder applies in `backend/src/persistence/identity.ts`, and
 * `backend/test/outcomeDecision.test.ts` fails if the two ever disagree — the
 * module cannot import across that boundary, so the duplication is a checked
 * mirror rather than a second home for the rule.
 */
export function decisionTimeOf(signal: ClassifiedSignal): DecisionTime {
  // Both clocks are required, not either: a receipt time without an emission
  // time (or the reverse) is a partial observation, and treating it as a full
  // one credits the pipeline latency it cannot account for. This matches
  // `computeDecisionAt` exactly — see the guard named above.
  const hasReceipt = typeof signal.receivedAt === "number" && Number.isFinite(signal.receivedAt);
  const hasEmit = typeof signal.emittedAt === "number" && Number.isFinite(signal.emittedAt);
  if (!hasReceipt || !hasEmit) {
    return { at: signal.lastTs, basis: "EVENT_TIME_ONLY" };
  }
  return {
    at: Math.max(signal.lastTs, signal.receivedAt!, signal.emittedAt),
    basis: "OBSERVED",
  };
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
