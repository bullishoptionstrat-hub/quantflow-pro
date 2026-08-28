/**
 * Outcome grading — forward returns for flow events.
 *
 * ─── HONEST SCOPE (read this before believing any number here) ──────────────
 *
 * This grades on **UNDERLYING returns**, not option P&L.
 *
 * Option-level P&L requires historical option marks at the grading timestamps,
 * which no free data source provides (see DATA_SOURCE_REGISTRY.md → BLOCKED).
 * Rather than fabricate an option price from a model and present it as a
 * result, every row records `return_basis: 'underlying'` and the UI must say
 * so. An underlying return is a real, checkable quantity; a modeled option P&L
 * would be a guess wearing a number's clothing.
 *
 * Consequences a reader must understand:
 *   - Theta, IV crush and spread costs are NOT captured.
 *   - A directionally correct call can still lose money in reality.
 *   - These grades measure "did the underlying move the way the flow implied",
 *     nothing more.
 *
 * ─── CAUSALITY ─────────────────────────────────────────────────────────────
 *
 * Grading uses `actionable_at`, never `signal_at`. Entry is the first mark at
 * or after actionable_at; exit is the first mark at or after actionable_at +
 * horizon. A mark from before actionable_at is never used, which is what stops
 * this from silently becoming a lookahead backtest.
 */

export type Horizon = '15m' | '1h' | '1d';

export const HORIZON_MS: Record<Horizon, number> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '1d': 24 * 60 * 60_000,
};

export type OutcomeLabel = 'WIN' | 'LOSS' | 'FLAT' | 'UNGRADED';

/**
 * Why a grade could not be produced. UNGRADED is a first-class result — it is
 * never coerced into FLAT to make a table look complete.
 */
export type UngradedReason =
  | 'ambiguous_direction'      // the flow's implied direction is unknown
  | 'no_entry_mark'            // no price at/after actionable_at
  | 'no_exit_mark'             // no price at/after the horizon
  | 'entry_mark_before_actionable'
  | 'zero_entry_price'
  | 'horizon_not_elapsed';     // too early to grade

export interface PriceMark {
  /** Epoch ms. */
  time: number;
  price: number;
}

export interface GradeInput {
  flowEventId: string;
  symbol: string;
  /** When the signal itself occurred. */
  signalAt: number;
  /** Earliest moment a strategy could have acted. MUST be >= signalAt. */
  actionableAt: number;
  /**
   * Direction the flow implies. `null` when the aggressor side was AMBIGUOUS —
   * this is the common case and yields UNGRADED, never a coin flip.
   */
  impliedDirection: 'LONG' | 'SHORT' | null;
  horizon: Horizon;
  /** Underlying marks, any order. */
  marks: readonly PriceMark[];
  /** Grading clock. */
  now: number;
  /** |return| below this is FLAT rather than a WIN/LOSS. */
  flatThreshold?: number;
  isSynthetic?: boolean;
}

export interface GradeResult {
  flowEventId: string;
  symbol: string;
  horizon: Horizon;
  signalAt: number;
  actionableAt: number;
  evaluatedAt: number | null;
  entryMark: number | null;
  exitMark: number | null;
  underlyingReturn: number | null;
  label: OutcomeLabel;
  ungradedReason: UngradedReason | null;
  returnBasis: 'underlying';
  isSynthetic: boolean;
  isDemo: boolean;
  calculationVersion: string;
}

export const GRADER_VERSION = 'grader-v1-underlying';
export const DEFAULT_FLAT_THRESHOLD = 0.001; // 0.1%

/** First mark at or after `t`. Never returns an earlier mark. */
export function firstMarkAtOrAfter(marks: readonly PriceMark[], t: number): PriceMark | null {
  let best: PriceMark | null = null;
  for (const m of marks) {
    if (m.time < t) continue;
    if (best === null || m.time < best.time) best = m;
  }
  return best;
}

export function gradeEvent(input: GradeInput): GradeResult {
  const {
    flowEventId, symbol, signalAt, actionableAt, impliedDirection, horizon,
    marks, now, flatThreshold = DEFAULT_FLAT_THRESHOLD, isSynthetic = false,
  } = input;

  const base = {
    flowEventId, symbol, horizon, signalAt, actionableAt,
    returnBasis: 'underlying' as const,
    isSynthetic,
    // Synthetic input can only ever produce a demo-flagged outcome.
    isDemo: isSynthetic,
    calculationVersion: GRADER_VERSION,
  };

  const ungraded = (reason: UngradedReason, evaluatedAt: number | null = now): GradeResult => ({
    ...base,
    evaluatedAt,
    entryMark: null,
    exitMark: null,
    underlyingReturn: null,
    label: 'UNGRADED',
    ungradedReason: reason,
  });

  // An ambiguous aggressor side means we do not know what "right" would be.
  // Guessing here is how a flow tool manufactures a hit rate.
  if (impliedDirection === null) return ungraded('ambiguous_direction');

  const exitTime = actionableAt + HORIZON_MS[horizon];
  if (now < exitTime) return ungraded('horizon_not_elapsed', null);

  const entry = firstMarkAtOrAfter(marks, actionableAt);
  if (!entry) return ungraded('no_entry_mark');
  // Defensive: firstMarkAtOrAfter already guarantees this, but a future change
  // to that helper must not silently introduce lookahead.
  if (entry.time < actionableAt) return ungraded('entry_mark_before_actionable');
  if (entry.price === 0) return ungraded('zero_entry_price');

  const exit = firstMarkAtOrAfter(marks, exitTime);
  if (!exit) return ungraded('no_exit_mark');

  const rawReturn = (exit.price - entry.price) / entry.price;
  // A SHORT profits when the underlying falls, so its return is negated.
  const directedReturn = impliedDirection === 'LONG' ? rawReturn : -rawReturn;

  const label: OutcomeLabel =
    Math.abs(directedReturn) < flatThreshold ? 'FLAT' : directedReturn > 0 ? 'WIN' : 'LOSS';

  return {
    ...base,
    evaluatedAt: now,
    entryMark: entry.price,
    exitMark: exit.price,
    underlyingReturn: directedReturn,
    label,
    ungradedReason: null,
  };
}

export interface OutcomeReport {
  total: number;
  graded: number;
  ungraded: number;
  wins: number;
  losses: number;
  flat: number;
  /** Wins / graded. null when nothing is graded — never 0/0 presented as 0%. */
  hitRate: number | null;
  averageReturn: number | null;
  ungradedByReason: Record<string, number>;
  returnBasis: 'underlying';
  note: string;
}

/**
 * Aggregate honestly: UNGRADED rows are COUNTED but excluded from the hit rate,
 * and the count is reported so a 90% hit rate over 3 of 500 events is visible
 * as such.
 */
export function buildReport(results: readonly GradeResult[]): OutcomeReport {
  const graded = results.filter((r) => r.label !== 'UNGRADED');
  const wins = graded.filter((r) => r.label === 'WIN').length;
  const losses = graded.filter((r) => r.label === 'LOSS').length;
  const flat = graded.filter((r) => r.label === 'FLAT').length;

  const ungradedByReason: Record<string, number> = {};
  for (const r of results) {
    if (r.label !== 'UNGRADED') continue;
    const k = r.ungradedReason ?? 'unknown';
    ungradedByReason[k] = (ungradedByReason[k] ?? 0) + 1;
  }

  const returns = graded
    .map((r) => r.underlyingReturn)
    .filter((v): v is number => typeof v === 'number');

  return {
    total: results.length,
    graded: graded.length,
    ungraded: results.length - graded.length,
    wins,
    losses,
    flat,
    hitRate: graded.length === 0 ? null : wins / graded.length,
    averageReturn: returns.length === 0 ? null : returns.reduce((s, v) => s + v, 0) / returns.length,
    ungradedByReason,
    returnBasis: 'underlying',
    note:
      'Graded on UNDERLYING returns only. Option-level P&L requires historical option marks, ' +
      'which no free data source provides. Theta, IV crush and spread costs are NOT captured.',
  };
}
