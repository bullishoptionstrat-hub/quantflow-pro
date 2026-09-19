/**
 * QuantFlow Pro — scanner backtest over your own graded history.
 *
 * Tradytics' pitch — "large call sweeps within 15 minutes of a key level, here
 * is how that performed across hundreds of past instances" — is, in this
 * architecture, *a filter applied to `signal_history` joined to
 * `signal_outcomes`*. Roadmap 4.1. This module is that filter and nothing more.
 *
 * The three rules that make it honest are not re-implemented here. They are the
 * same rules `/api/track-record` already enforces, reached the same way:
 *
 *   - **No second grader (4.2).** A backtest does not grade anything. Grading
 *     happened once, when the outcome was written by `SignalGrader`. This reads
 *     those outcomes back through the *same* `tallyOutcome` → `tallyToRows` →
 *     `reportNotes` path the track record uses. Ledger line 74's rule was
 *     "hold two copies in agreement rather than allow a third"; the better
 *     version, taken in `trackRecordRows.ts`, is one copy — and a backtest that
 *     computed its own labels would be exactly the third copy that rule forbids.
 *
 *   - **Every honesty flag carries through (4.3).** Because the tally is shared,
 *     a backtest inherits all of them for free: synthetic signals never enter a
 *     rate, `EVENT_TIME_ONLY` and rights-refused signals are excluded and
 *     counted, `UNGRADED` outcomes stay in the denominator's `nUngraded` and
 *     are never dropped, `INSUFFICIENT_SAMPLE` suppresses a rate below n=30, and
 *     `MAX_EXCURSION` / measured-interval disclosure travels on every row. A
 *     backtester that dropped these is the entire failure mode of the category;
 *     this one *cannot* drop them without editing the shared module and failing
 *     its tests.
 *
 * The only thing this module adds is *which signals are in the population*. The
 * arithmetic over that population is borrowed, on purpose.
 */
import {
  emptyTally, tallyOutcome, tallyToRows, reportNotes, type OutcomeTally,
} from './trackRecordRows';
import {
  MIN_PUBLISHABLE_SAMPLE,
  type OutcomeRecord,
  type SignalRecord,
  type TrackRecordRow,
} from './types';

/**
 * A scanner filter: the shape of the signals a backtest asks about.
 *
 * Every field is optional and every present field is a conjunction — a signal
 * is in the population only if it satisfies all of them. An absent field is
 * *not* a constraint, which is different from an empty one: `kinds: []` would
 * match nothing (a signal's kind is in no set), and that is a real query a
 * caller can make, distinct from omitting `kinds` to mean "any kind". The
 * route rejects the empty-array case rather than returning a confidently empty
 * backtest, but the matcher honours it literally — see `matchesScanner`.
 */
export interface ScannerFilter {
  /** Classifier kinds to include, e.g. `['SWEEP', 'BLOCK']`. Case-insensitive. */
  kinds?: string[];
  /** Underlyings to include, e.g. `['SPY', 'AAPL']`. Case-insensitive. */
  underlyings?: string[];
  /** Signal sides to include, e.g. `['BUY']`. Case-insensitive. */
  sides?: string[];
  /** Minimum total premium, inclusive. */
  minPremium?: number;
  /** Minimum total contracts, inclusive. */
  minSize?: number;
  /** Minimum unusualness score, inclusive. */
  minScore?: number;
  /** Intermarket-sweep only when true; either when absent. */
  isoOnly?: boolean;
  /** Lower bound on `decisionAt` (epoch ms), inclusive. */
  from?: number;
  /** Upper bound on `decisionAt` (epoch ms), inclusive. */
  to?: number;
}

/**
 * The filter as it was actually applied, echoed on the report.
 *
 * A backtest that silently dropped a constraint it could not honour would be
 * the same class of lie as a hit rate that dropped its hard cases. So the
 * report says which constraints it applied, and the route builds this from the
 * *validated* filter, not from the raw request — a rejected field is a 400, not
 * a quietly ignored one.
 */
export type AppliedFilter = ScannerFilter;

export interface BacktestReport {
  generatedAt: string;
  /** The filter this report was computed under, exactly as applied. */
  filter: AppliedFilter;
  /**
   * How many signals matched the filter *before* any exclusion. This is the
   * denominator the reader cares about first: a filter matching six signals
   * cannot produce a publishable rate no matter how they graded.
   */
  matched: number;
  /** Rows over the matched, real, permitted, observed population. */
  rows: TrackRecordRow[];
  /**
   * Exclusions, scoped to the matched population — not the whole store. A
   * reader comparing this against `/api/track-record`'s global counts can see
   * how much of each exclusion their filter selected for.
   */
  excluded: {
    synthetic: number;
    eventTimeOnlyBasis: number;
    rightsRefused: number;
  };
  minSample: number;
  notes: string[];
}

const lc = (s: string) => s.toLowerCase();

/**
 * Does one signal belong in this backtest's population?
 *
 * String matches are case-insensitive and set-membership; numeric bounds are
 * inclusive; `isoOnly` is a one-way filter (true demands ISO, absent demands
 * nothing). The empty array matches nothing, deliberately — see the note on
 * `ScannerFilter`.
 *
 * This is purely a *selection* predicate. It never looks at an outcome, a
 * label, or a mark: what a matched signal did is the tally's business, and
 * keeping selection and grading apart is what stops this file from growing a
 * second grader.
 */
export function matchesScanner(sig: SignalRecord, f: ScannerFilter): boolean {
  if (f.kinds && !f.kinds.map(lc).includes(lc(sig.kind))) return false;
  if (f.underlyings && !f.underlyings.map(lc).includes(lc(sig.underlying))) return false;
  if (f.sides && !f.sides.map(lc).includes(lc(sig.side))) return false;
  if (f.minPremium !== undefined && !(sig.totalPremium >= f.minPremium)) return false;
  if (f.minSize !== undefined && !(sig.totalSize >= f.minSize)) return false;
  if (f.minScore !== undefined && !(sig.score >= f.minScore)) return false;
  if (f.isoOnly === true && !sig.iso) return false;
  if (f.from !== undefined && !(sig.decisionAt >= f.from)) return false;
  if (f.to !== undefined && !(sig.decisionAt <= f.to)) return false;
  return true;
}

/**
 * One matched signal, paired with its live outcomes, ready to tally.
 *
 * The store produces these — it is the only part that differs between the
 * in-memory maps and the paged PostgREST reads. Everything after is shared.
 */
export interface MatchedSignal {
  signal: Pick<SignalRecord, 'kind' | 'synthetic' | 'decisionBasis' | 'rightsClass'>;
  outcomes: Pick<OutcomeRecord, 'horizon' | 'label' | 'excursion' | 'entryMarkAt' | 'exitMarkAt'>[];
}

/**
 * Assemble a backtest report from an already-matched, already-joined
 * population.
 *
 * This is the shared arithmetic — identical for both stores, and identical in
 * substance to `InMemorySignalStore.trackRecord`'s inner loop. The exclusion
 * order is the same (synthetic, then event-time, then rights), and it is a
 * `continue` chain for the same reason: a signal excluded for one cause is not
 * counted under a second, so the exclusion buckets sum to the excluded total
 * rather than double-counting.
 *
 * `storeNotes` carries the same store-specific channel `reportNotes` takes for
 * the track record — the in-memory eviction warning is as true of a backtest
 * over a retained window as of a track record over one.
 */
export function assembleBacktest(
  filter: AppliedFilter,
  matched: MatchedSignal[],
  storeNotes: readonly string[] = [],
): BacktestReport {
  const excluded = { synthetic: 0, eventTimeOnlyBasis: 0, rightsRefused: 0 };
  const tallies = new Map<string, OutcomeTally>();

  for (const { signal, outcomes } of matched) {
    if (signal.synthetic) { excluded.synthetic++; continue; }
    if (signal.decisionBasis === 'EVENT_TIME_ONLY') { excluded.eventTimeOnlyBasis++; continue; }
    if (signal.rightsClass !== 'PERMITTED') { excluded.rightsRefused++; continue; }

    for (const o of outcomes) {
      const key = `${signal.kind}|${o.horizon}`;
      const t = tallies.get(key) ?? emptyTally(signal.kind, o.horizon);
      tallyOutcome(t, o);
      tallies.set(key, t);
    }
  }

  const rows = tallyToRows(tallies.values());

  const notes = reportNotes(rows, excluded, storeNotes);
  // One backtest-specific sentence the track record does not need: an empty
  // match is a different fact from an empty store, and the reader is choosing a
  // filter, so tell them the filter is what came back empty.
  if (matched.length === 0) {
    notes.unshift(
      'No signal in the record matched this scanner filter. This is a statement ' +
      'about the filter and the history collected so far, not about any signal ' +
      "having failed — widen the filter or wait for more history.",
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    filter,
    matched: matched.length,
    rows,
    excluded,
    minSample: MIN_PUBLISHABLE_SAMPLE,
    notes,
  };
}
