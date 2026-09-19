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
  /**
   * Which source priced each mark. Present exactly when the mark is.
   *
   * Recorded because the grader now resolves its mark from a ranked registry
   * rather than one hard-wired vendor, so "where did this price come from?"
   * stopped being answerable from the deployment's configuration alone. The two
   * can differ: a vendor can drop out between registration and a checkpoint.
   */
  entryMarkSource?: string;
  exitMarkSource?: string;
  /**
   * When each mark was true, on the vendor's clock. Present exactly when the
   * mark is.
   *
   * The horizon on this row is a *scheduling* label — when the checkpoint fell
   * due — and these two are what was actually measured between. They are
   * persisted rather than collapsed into a duration for the same reason
   * `MAX_EXCURSION` is named on the payload instead of being presented as a
   * held return: a reader months later should be able to see that an `M15` row
   * spanned nineteen minutes, not take the label's word for it.
   */
  entryMarkAt?: number;
  exitMarkAt?: number;
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

/**
 * How long each horizon nominally is, measured from `decisionAt`.
 *
 * Moved here from `grader.ts` (which re-exports it) because it stopped being
 * only the grader's business: `/api/track-record` needs it to say whether the
 * interval a row was *measured* over matches the horizon it is *filed* under.
 * `EXPIRY` has no fixed length and is absent rather than guessed.
 */
export const HORIZON_NOMINAL_MS: Record<Exclude<OutcomeHorizon, 'EXPIRY'>, number> = {
  M15: 15 * 60_000,
  H1: 60 * 60_000,
  D1: 24 * 60 * 60_000,
};

/**
 * The horizons the grader actually writes an outcome for.
 *
 * `OutcomeHorizon` has four members; `EXPIRY` is declared but deliberately
 * never graded (see `grader.ts`). Both stores' `listUngraded` used to ask for
 * fewer than **four** live outcomes, so a signal graded at every horizon the
 * grader will ever write still counted as open — the set could never drain.
 *
 * That was inert only because nothing called `listUngraded` outside tests. It
 * stops being inert the moment startup recovery does: every fully-graded
 * signal would be re-registered on every boot, re-graded, and written again as
 * a duplicate outcome row. One list, derived from the horizons the grader
 * schedules, so the two cannot disagree.
 */
export const GRADED_HORIZONS = ['M15', 'H1', 'D1'] as const satisfies
  readonly Exclude<OutcomeHorizon, 'EXPIRY'>[];

export type GradedHorizon = (typeof GRADED_HORIZONS)[number];

/**
 * The nominal length of a horizon named by an arbitrary string, or `undefined`.
 *
 * The table keeps its narrow type, so the grader indexes it with a key the
 * compiler has checked. Callers reading a horizon out of a *row* have only a
 * string — it came from a database column or a bucket key — and widening the
 * table to `Record<string, number>` to serve them would have made
 * `HORIZON_NOMINAL_MS['nonsense']` typecheck as a `number` while returning
 * undefined. That is the shape of every defect in this repo's ledger: a type
 * promising something the value does not.
 *
 * So the widening lives here, in a return type that admits it, and the cast is
 * guarded by the `in` check that makes it sound.
 */
export function nominalHorizonMs(horizon: string): number | undefined {
  // `hasOwnProperty`, not `in`: `in` walks the prototype chain, so
  // `nominalHorizonMs('toString')` answered `Object.prototype.toString` — a
  // **function**, returned through a signature promising `number | undefined`.
  // That is the exact defect the paragraph above claims to have avoided, and it
  // was introduced by the commit that wrote the paragraph. Measured, not
  // reasoned about: 'toString', 'constructor' and 'hasOwnProperty' all came
  // back as functions, and `NaN` in a published note is where it would have
  // surfaced.
  return Object.prototype.hasOwnProperty.call(HORIZON_NOMINAL_MS, horizon)
    ? HORIZON_NOMINAL_MS[horizon as Exclude<OutcomeHorizon, 'EXPIRY'>]
    : undefined;
}

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
  /**
   * What this bucket's graded rows were actually measured over.
   *
   * Present whenever anything graded, including when the rate itself is
   * suppressed — the sample-size gate is about not publishing a *rate* on thin
   * evidence, not about withholding the evidence's shape.
   */
  measuredInterval?: MeasuredInterval;
}

/**
 * The interval a bucket's outcomes were measured over, beside the horizon they
 * are filed under.
 *
 * The horizon is a *schedule*: when the checkpoint fell due. The mark stamps
 * are the *measurement*. On a mark source that refreshes more slowly than a
 * horizon is long — the free-tier rotation in `connectors/twelveData.ts` — a
 * row filed under `M15` can be measured over anything from fifteen minutes to
 * an hour, and a hit rate pooled across those is not a fifteen-minute hit
 * rate. Every platform in this category publishes the label and not the
 * interval; this publishes both.
 */
export interface MeasuredInterval {
  /** Graded outcomes carrying both mark stamps. */
  n: number;
  /** Graded outcomes carrying neither, which cannot say what they measured. */
  nUndated: number;
  /**
   * Omitted when `n` is 0 — never a zero standing in for "unknown", which is
   * the rule this file states for every other optional reading.
   */
  medianMs?: number;
  minMs?: number;
  maxMs?: number;
  /** The horizon's nominal length. Absent for `EXPIRY`, which has none. */
  nominalMs?: number;
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
  /**
   * Real (non-synthetic) signals whose grading is not yet complete.
   *
   * `sinceMs` bounds the search to signals decided at or after that instant.
   * It is optional because the store should not invent a retention policy —
   * the caller that has one is the grader, which knows its own horizons and
   * its own lateness tolerance.
   *
   * It is not a nicety. Without it the Supabase scan reads the OLDEST rows and
   * filters afterwards, so a fully-graded prefix — which is what a long
   * history becomes, since graded signals never leave the table — pushes every
   * pending signal past the window and this returns empty. Measured: 2,000
   * graded signals ahead of 100 pending ones returned 0.
   */
  listUngraded(limit: number, sinceMs?: number): Promise<SignalRecord[]>;
  countSignals(): Promise<{ total: number; synthetic: number; real: number }>;

  writeOutcome(rec: OutcomeRecord): Promise<void>;
  listOutcomes(signalKey: string): Promise<OutcomeRecord[]>;

  recordIncident(inc: WriteIncident): Promise<void>;
  listIncidents(limit: number): Promise<WriteIncident[]>;

  recordGap(gap: CollectionGap): Promise<void>;
  listGaps(sinceMs: number): Promise<CollectionGap[]>;

  trackRecord(): Promise<TrackRecordReport>;

  /**
   * A track record restricted to the signals a scanner filter selects.
   *
   * Same population rules and same arithmetic as `trackRecord` — it reuses the
   * shared tally rather than grading anything a second time — narrowed to the
   * matched signals. The return type lives in `backtest.ts` beside the filter
   * it answers.
   */
  backtest(filter: import('./backtest').ScannerFilter): Promise<import('./backtest').BacktestReport>;
}
