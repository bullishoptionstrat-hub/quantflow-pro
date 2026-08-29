/**
 * QuantFlow Pro — durable signal history: record shapes and the store contract
 *
 * The store is an interface with two implementations (in-memory for tests and
 * for running without a database; Supabase for deployment) so that the
 * persistence *policy* — what may be written, under what identity, with what
 * timestamps — is testable without credentials, and is identical in both.
 */
import type { DecisionBasis, WriteVerdict } from './identity';
import type { RightsClass } from '../provenance/rights';

// ─── Signals ────────────────────────────────────────────────────────────────

export interface StoredLeg {
  contractSymbol: string;
  underlying: string;
  right: 'C' | 'P';
  strike: number;
  expiry: string;
  side: string;
  totalSize: number;
  totalPremium: number;
  vwap: number;
  prints: number;
  exchanges: string[];
}

export interface SignalRecord {
  /** Content hash. The identity — stable across process restarts and replays. */
  signalKey: string;
  /** Same value; carried separately so reconciliation reads unambiguously. */
  contentHash: string;
  /**
   * The engine's own id (`sig_<seq>_<ts>`). Ephemeral: the sequence restarts
   * at 1 on every boot, so it is bookkeeping, never identity. Kept to join
   * back to logs from the same process lifetime.
   */
  engineId: string;

  kind: string;
  underlying: string;
  side: string;
  totalPremium: number;
  totalSize: number;
  iso: boolean;
  score: number;
  scoreBreakdown: Record<string, number>;
  legs: StoredLeg[];
  spreadGuess?: string;

  // ── Time ──
  firstEventAt: number;
  lastEventAt: number;
  /** The measurement timestamp. See identity.computeDecisionAt. */
  decisionAt: number;
  decisionBasis: DecisionBasis;
  latencyMs: number;

  // ── Provenance ──
  source: string;
  datasetId: string;
  rightsClass: RightsClass | 'UNKNOWN_DATASET';
  /** True when any forming print came from the simulator or a replay. */
  synthetic: boolean;
  /** Wall clock at insert. Storage bookkeeping, never a measurement input. */
  recordedAt: number;
}

/** A rejected or conflicting write, kept as evidence about the pipeline. */
export interface WriteIncident {
  signalKey: string;
  incidentType: 'HISTORY_COLLISION';
  existingContentHash: string;
  incomingContentHash: string;
  detectedAt: number;
  note: string;
}

// ─── Outcomes ───────────────────────────────────────────────────────────────

export type OutcomeHorizon = 'M15' | 'H1' | 'D1' | 'EXPIRY';

export type OutcomeLabelValue =
  | 'POSITIVE'
  | 'NEGATIVE'
  | 'FLAT'
  /** Could not be graded. Reported, never dropped — see the note below. */
  | 'UNGRADED';

export interface OutcomeRecord {
  signalKey: string;
  horizon: OutcomeHorizon;
  label: OutcomeLabelValue;
  /** Return of the underlying in the signal's implied direction, or undefined. */
  excursion?: number;
  /** Mark used at entry, and at the checkpoint. Absent when not observable. */
  entryMark?: number;
  exitMark?: number;
  /** When the checkpoint fell due, and when it was actually evaluated. */
  dueAt: number;
  evaluatedAt: number;
  /**
   * Why a row is UNGRADED. Required when label is UNGRADED — an ungraded
   * outcome with no stated reason is indistinguishable from a bug.
   */
  ungradedReason?: string;
  /** Append-only: a correction supersedes, it never overwrites. */
  supersedes?: string;
  revision: number;
}

// ─── Collection coverage ────────────────────────────────────────────────────

/**
 * `OBSERVED_EMPTY` and `NOT_OBSERVED` are different facts and the difference
 * is not academic. Outages cluster in volatile sessions, because rate limits
 * bite hardest when volume spikes — exactly the periods where a signal would
 * be tested hardest. Silently dropping them removes the hard cases and makes
 * any hit rate computed over the window flattering.
 */
export type GapKind =
  /** We were collecting and nothing happened. This is data. */
  | 'OBSERVED_EMPTY'
  /** We were not collecting. This is an absence of data. */
  | 'NOT_OBSERVED'
  /** Benign: the market was shut. Does not reduce coverage. */
  | 'MARKET_CLOSED';

export interface CollectionGap {
  id: string;
  kind: GapKind;
  startedAt: number;
  endedAt: number;
  /** Free text, but must be substantive — see memoryStore's guard. */
  reason: string;
  source?: string;
}

// ─── Track record ───────────────────────────────────────────────────────────

/** Below this many graded outcomes, no rate is published. */
export const MIN_PUBLISHABLE_SAMPLE = 30;

export interface TrackRecordRow {
  kind: string;
  horizon: OutcomeHorizon;
  nTotal: number;
  nGraded: number;
  nUngraded: number;
  /** Omitted entirely when the sample is too small — never rendered as 0. */
  hitRate?: number;
  medianExcursion?: number;
  suppressionReason?: 'INSUFFICIENT_SAMPLE';
}

export interface TrackRecordReport {
  generatedAt: string;
  /** Rows computed from real, graded, forward-observed outcomes only. */
  rows: TrackRecordRow[];
  /**
   * Synthetic signals are counted here and NOWHERE else. They never enter
   * `rows`. Reporting the count rather than hiding it is deliberate: a reader
   * seeing "0 real signals, 4,812 synthetic" learns the truth about this
   * deployment immediately.
   */
  excluded: {
    synthetic: number;
    eventTimeOnlyBasis: number;
    rightsRefused: number;
  };
  minSample: number;
  notes: string[];
}

// ─── Store contract ─────────────────────────────────────────────────────────

export interface WriteResult {
  verdict: WriteVerdict;
  signalKey: string;
}

export interface SignalStore {
  readonly kind: 'memory' | 'supabase';

  /** Reconcile-then-write. Never overwrites differing content. */
  writeSignal(rec: SignalRecord): Promise<WriteResult>;
  getSignal(signalKey: string): Promise<SignalRecord | undefined>;
  /** Real (non-synthetic) signals whose grading is not yet complete. */
  listUngraded(limit: number): Promise<SignalRecord[]>;
  countSignals(): Promise<{ total: number; synthetic: number; real: number }>;

  writeOutcome(rec: OutcomeRecord): Promise<void>;
  listOutcomes(signalKey: string): Promise<OutcomeRecord[]>;

  recordIncident(inc: WriteIncident): Promise<void>;
  listIncidents(limit: number): Promise<WriteIncident[]>;

  recordGap(gap: CollectionGap): Promise<void>;
  listGaps(sinceMs: number): Promise<CollectionGap[]>;

  trackRecord(): Promise<TrackRecordReport>;
}
