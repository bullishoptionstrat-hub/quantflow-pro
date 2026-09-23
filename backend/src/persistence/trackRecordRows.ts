/**
 * The rows and notes `/api/track-record` publishes, built once for both stores.
 *
 * Two implementations of this existed — `memoryStore.trackRecord()` and
 * `supabaseStore.trackRecord()` — because the two gather outcomes completely
 * differently: one walks maps in process, the other pages PostgREST in chunks
 * of 500. What they do *after* gathering is identical, and it had already
 * drifted in the direction that matters least visibly and most: the Supabase
 * copy carries a note warning that the M15/H1/D1 rows for one kind are three
 * readings of the **same** signals rather than three independent samples, and
 * the memory copy does not. `storeKind` is `memory` on this deployment, so the
 * store that has never run was the honest one and the store actually answering
 * the endpoint was the quiet one.
 *
 * Ledger line 74's rule is the precedent: when grading logic got a second home,
 * a test was written to hold the two copies in agreement rather than allowing a
 * third. Here the two copies collapse into one instead, which is the better
 * version of the same move — there is nothing left to hold in agreement.
 *
 * Gathering stays in each store. Only the arithmetic and the prose live here.
 */
import {
  MIN_PUBLISHABLE_SAMPLE,
  nominalHorizonMs,
  type MeasuredInterval,
  type TrackRecordRow,
} from './types';

/** Running tallies for one (kind, horizon) bucket. */
export interface OutcomeTally {
  kind: string;
  horizon: string;
  nTotal: number;
  nGraded: number;
  nUngraded: number;
  hits: number;
  directionalReturns: number[];
  /** Measured intervals, for graded rows that carried both mark stamps. */
  intervals: number[];
  /** Graded rows that carried neither, and so cannot say what they measured. */
  nUndated: number;
}

export function emptyTally(kind: string, horizon: string): OutcomeTally {
  return {
    kind, horizon,
    nTotal: 0, nGraded: 0, nUngraded: 0, hits: 0,
    directionalReturns: [], intervals: [], nUndated: 0,
  };
}

/** The shape this module needs from an outcome, whichever store produced it. */
export interface TallyableOutcome {
  label: string;
  directionalReturnAtHorizon?: number;
  entryMarkAt?: number;
  exitMarkAt?: number;
}

export function tallyOutcome(t: OutcomeTally, o: TallyableOutcome): void {
  t.nTotal++;
  if (o.label === 'UNGRADED') { t.nUngraded++; return; }

  t.nGraded++;
  if (o.label === 'POSITIVE') t.hits++;
  if (typeof o.directionalReturnAtHorizon === 'number')
    t.directionalReturns.push(o.directionalReturnAtHorizon);

  // The interval a row was actually measured over, which is not the horizon it
  // is filed under. Both stamps or neither: an interval computed from one is
  // not an interval. Rows written before `entry_mark_at`/`exit_mark_at` existed
  // land in `nUndated` rather than being dropped or defaulted — "this row
  // cannot say" is a different fact from "this row measured zero".
  if (typeof o.entryMarkAt === 'number' && typeof o.exitMarkAt === 'number') {
    t.intervals.push(o.exitMarkAt - o.entryMarkAt);
  } else {
    t.nUndated++;
  }
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

function intervalOf(t: OutcomeTally): MeasuredInterval | undefined {
  if (t.nGraded === 0) return undefined;
  const mi: MeasuredInterval = { n: t.intervals.length, nUndated: t.nUndated };
  const nominal = nominalHorizonMs(t.horizon);
  // EXPIRY has no fixed length, so it has no nominal to compare against and
  // the field is absent rather than guessed.
  if (nominal !== undefined) mi.nominalMs = nominal;
  if (t.intervals.length > 0) {
    mi.medianMs = median(t.intervals);
    // Folded rather than spread. `Math.min(...xs)` passes every element as an
    // argument, and the Supabase history has no cap — a bucket larger than
    // Node's argument limit would make this throw instead of returning the
    // report, turning an accumulated track record into a 500. The in-memory
    // store caps at 50,000 signals; the table it is meant to be replaced by
    // does not, so the limit is reachable exactly once the endpoint starts
    // mattering.
    let lo = t.intervals[0]!;
    let hi = lo;
    for (const v of t.intervals) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    mi.minMs = lo;
    mi.maxMs = hi;
  }
  return mi;
}

/**
 * Tallies to published rows.
 *
 * `measuredInterval` is attached **before** the sample-size gate, deliberately:
 * a suppressed row still gets to say what its sample was measured over. The
 * suppression is about not publishing a *rate* on thin evidence, not about
 * withholding the evidence's shape.
 */
export function tallyToRows(tallies: Iterable<OutcomeTally>): TrackRecordRow[] {
  return [...tallies]
    .map((t) => {
      const row: TrackRecordRow = {
        kind: t.kind,
        horizon: t.horizon as TrackRecordRow['horizon'],
        nTotal: t.nTotal,
        nGraded: t.nGraded,
        nUngraded: t.nUngraded,
      };
      const mi = intervalOf(t);
      if (mi) row.measuredInterval = mi;

      if (t.nGraded < MIN_PUBLISHABLE_SAMPLE) {
        row.suppressionReason = 'INSUFFICIENT_SAMPLE';
        return row;
      }
      row.hitRate = t.hits / t.nGraded;
      if (t.directionalReturns.length > 0)
        row.medianDirectionalReturn = median(t.directionalReturns);
      return row;
    })
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.horizon.localeCompare(b.horizon));
}

const mins = (ms: number) => Math.round(ms / 60_000);

/**
 * Every note the endpoint publishes, in one place.
 *
 * These are the sentences that keep the numbers beside them honest, so a note
 * present in one store's copy and missing from the other's is a real
 * difference in what a reader is told. That had already happened; see the
 * header.
 */
export function reportNotes(
  rows: TrackRecordRow[],
  excluded: { synthetic: number; eventTimeOnlyBasis: number; rightsRefused: number },
  /**
   * Notes only one store can make, appended last.
   *
   * This parameter exists because collapsing the two copies **dropped one**:
   * the in-memory store warned when its 50,000-signal cap had evicted the
   * oldest rows, so `/api/track-record` could otherwise present a
   * retained-window rate as the whole record. A shared note list cannot carry
   * that — the Supabase store has no cap and the claim would be false there —
   * and deleting it was the same defect this module was written to fix, in the
   * opposite direction and introduced by the fix. Store-specific facts come
   * through here; shared prose never does.
   */
  storeNotes: readonly string[] = [],
): string[] {
  const notes: string[] = [];

  if (rows.length === 0) {
    notes.push(
      'No real, permitted, forward-observed signal has completed a checkpoint yet. ' +
      'This is the expected state until a licensed feed is connected — it is not an error.',
    );
  }

  if (rows.length > 1) {
    notes.push(
      'Rows are grouped by (kind, horizon), and each signal is graded at every ' +
      'horizon — so the M15, H1 and D1 rows for one kind are three readings of ' +
      'the SAME signals, not three independent samples. Do not multiply them ' +
      'together or treat agreement across horizons as corroboration.',
    );
  }

  // The disclosure this module was extended for. A hit rate filed under `M15`
  // whose rows were measured over a median of 32 minutes is not a 15-minute hit
  // rate, and on a mark source slower than the horizon that is the ordinary
  // case rather than an anomaly — see the Twelve Data rotation in
  // `connectors/twelveData.ts`. The horizon names when the checkpoint fell due;
  // the mark stamps name what was measured. Reported rather than corrected,
  // because correcting it would mean picking a tolerance and discarding rows,
  // and the reader is better served by the number and its interval than by a
  // smaller number with a rule they cannot see.
  const over = rows.filter((r) => {
    const mi = r.measuredInterval;
    return mi?.medianMs !== undefined && mi.nominalMs !== undefined
      && mi.medianMs > mi.nominalMs;
  });
  if (over.length > 0) {
    notes.push(
      `${over.length} row(s) were measured over a longer interval than the horizon ` +
      'they are filed under — ' +
      over.map((r) => {
        const mi = r.measuredInterval!;
        return `${r.kind}/${r.horizon}: median ${mins(mi.medianMs!)}min ` +
          `(${mins(mi.minMs!)}–${mins(mi.maxMs!)}min) against ${mins(mi.nominalMs!)}min nominal`;
      }).join('; ') +
      '. The horizon names when the checkpoint fell due; the mark stamps name what ' +
      'was actually measured, and a mark source that refreshes more slowly than a ' +
      'horizon is long makes those differ. A rate pooled across intervals of ' +
      'different lengths is not a rate for the interval its label names.',
    );
  }

  // Not `?? 0`: a row with no `measuredInterval` at all has nothing graded,
  // which is a different fact from "nothing undated", and the zero-fill rule
  // here applies to a count the same as to a price.
  const undated = rows.filter((r) => {
    const mi = r.measuredInterval;
    return mi !== undefined && mi.nUndated > 0;
  });
  if (undated.length > 0) {
    const n = undated.reduce((sum, r) => sum + r.measuredInterval!.nUndated, 0);
    notes.push(
      `${n} graded outcome(s) carry no mark stamps and so cannot say what interval ` +
      'they were measured over. They are counted in the rates and excluded from the ' +
      'interval figures, because omitting them from the rate would silently change ' +
      'which sample it describes. Rows written before mark stamps existed are the ' +
      'expected cause.',
    );
  }

  if (excluded.synthetic > 0) {
    notes.push(
      `${excluded.synthetic} synthetic signal(s) were excluded. Synthetic data is ` +
      'generated by this process and carries no information about the market; it is ' +
      'counted here and never enters a rate.',
    );
  }
  if (excluded.eventTimeOnlyBasis > 0) {
    notes.push(
      `${excluded.eventTimeOnlyBasis} signal(s) were excluded for having an ` +
      'EVENT_TIME_ONLY decision basis. Their decision time is a lower bound that ' +
      'credits zero feed latency, so pooling them with observed rows would bias ' +
      'the result optimistically.',
    );
  }
  if (excluded.rightsRefused > 0) {
    notes.push(
      `${excluded.rightsRefused} signal(s) were excluded: the source is not ` +
      'affirmatively permitted for persistence under the active business mode.',
    );
  }

  notes.push(...storeNotes);
  return notes;
}
