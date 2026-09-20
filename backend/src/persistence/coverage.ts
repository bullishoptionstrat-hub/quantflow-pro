/**
 * What happened during the windows when nothing was recorded.
 *
 * `collection_gaps` has a table with three CHECK constraints, a typed
 * `CollectionGap`, a `GapKind` union with a paragraph explaining why its two
 * main members are different facts, and `recordGap`/`listGaps` implemented in
 * both stores. **Nothing in production has ever called `recordGap`.** Not once:
 * `grep -rn recordGap src/` finds the two implementations and no caller.
 *
 * That is not a cosmetic hole. `types.ts` states the reason the table exists:
 *
 *   "`OBSERVED_EMPTY` and `NOT_OBSERVED` are different facts and the
 *    difference is not academic. Outages cluster in volatile sessions, because
 *    rate limits bite hardest when volume spikes — exactly the periods where a
 *    signal would be tested hardest. Silently dropping them removes the hard
 *    cases and makes any hit rate computed over the window flattering."
 *
 * So the apparatus built to stop a flattering hit rate has never recorded a
 * single row, and a track record computed today would carry exactly the bias it
 * was designed to expose. This module is the missing writer.
 *
 * **`MARKET_CLOSED` is deliberately never emitted here**, though the union
 * offers it. Classifying a window as benignly shut needs a holiday calendar
 * this codebase does not have, and CLAUDE.md already records what happens
 * without one — a `MARKET OPEN` indicator over "a weekday-and-clock check with
 * no holiday calendar: a green dot on Thanksgiving". The failure direction is
 * what settles it: mislabelling a real outage as a benign closure converts
 * missing data into data that was never expected, which is the flattering
 * direction and the one this table exists to prevent. An honest
 * `NOT_OBSERVED` over a closed market overstates the gap, which is the
 * direction that costs nothing but a reader's time.
 */
import type { CollectionGap, GapKind } from './types';

/** What the runtime can tell us at one instant. */
export interface CoverageSample {
  /**
   * Is a source whose data could be recorded currently connected?
   *
   * Not "is the process up" — a process with every connector disabled is
   * running and observing nothing, and that is the case the whole table is
   * about.
   */
  collecting: boolean;
  /** Why not, when not. Reaches a public payload, so no credentials. */
  reason: string;
  /** Real (non-synthetic) signals recorded since boot. Monotonic. */
  recorded: number;
}

/** A window's classification, or `null` when the window was productive. */
export interface WindowVerdict {
  kind: GapKind;
  reason: string;
}

/**
 * Classify one window. Pure — the whole point is that this is drivable.
 *
 * Three outcomes, and the middle one is the one people forget:
 *
 *   - not collecting        → NOT_OBSERVED. An absence of data.
 *   - collecting, nothing   → OBSERVED_EMPTY. This *is* data: the tape really
 *                             was quiet, and a backtest may use the window.
 *   - collecting, something → no gap.
 */
export function classifyWindow(
  sample: CoverageSample,
  recordedAtWindowStart: number,
): WindowVerdict | null {
  if (!sample.collecting) {
    return {
      kind: 'NOT_OBSERVED',
      // The store refuses a reason under 10 characters, because a gap's reason
      // is read months later by someone deciding whether a window is usable.
      reason: `Not collecting: ${sample.reason}`,
    };
  }
  if (sample.recorded > recordedAtWindowStart) return null;
  return {
    kind: 'OBSERVED_EMPTY',
    reason:
      'Collecting and nothing arrived. The feed was up and the tape was quiet, ' +
      'which is a measurement rather than an outage.',
  };
}

/**
 * Turns a stream of samples into as few gap rows as possible.
 *
 * A tick every minute writing one row per tick is 1,440 rows a day and a table
 * nobody can read. Contiguous windows of the same kind are one gap, extended in
 * place under a stable id — `recordGap` upserts on `id`, so re-recording an
 * open gap replaces it rather than duplicating.
 *
 * The id encodes the kind and the instant the run started, so a process that
 * dies mid-gap leaves the last written extent behind rather than losing the
 * whole window.
 *
 * **That used to claim the tail was under-reported "by at most one tick". It
 * is not, and the live database says so.** That reasoning holds for a process
 * that dies and is restarted promptly. The documented host sleeps after 15
 * minutes of inactivity and stays asleep for hours, and across a sleep:
 *
 *   - the open gap freezes at its last written extent, and its `endedAt`
 *     becomes a POSITIVE claim that collection resumed at that instant;
 *   - on wake `lastTickAt` is null, so the first tick establishes a baseline
 *     and writes nothing, and the next window starts at the WAKE instant.
 *
 * The sleep interval is therefore attributed to nobody. Measured on the live
 * project on 2026-09-20, over a 4,160-minute span of recorded signals:
 *
 *   9 gap rows, 126 minutes total  = 3.03% of the span
 *   every row the SAME duration (~14 min) — the signature of freeze-at-sleep,
 *     not of outages having a natural length
 *   longest silence in signal_history with NO gap row at all: 1,978 min (33 h)
 *
 * So the table built to stop a flattering hit rate under-reported non-
 * collecting time by roughly 97%, reproducing precisely the bias its own
 * docstring describes. `recoverMissedWindow()` is the missing half: a boot
 * cannot know it is about to sleep, but the NEXT boot can see the hole and
 * attribute it. Same shape as `SignalGrader.recover()`, for the same reason.
 */
export class CoverageRecorder {
  private open: (CollectionGap & { kind: GapKind }) | null = null;
  private recordedAtWindowStart = 0;
  private lastTickAt: number | null = null;

  constructor(private readonly idPrefix: string = 'gap') {}

  /** The gap currently being extended, for the health projection. */
  getOpenGap(): CollectionGap | null {
    return this.open ? { ...this.open } : null;
  }

  /**
   * Advance to `now`, and return the gap row to write, if any.
   *
   * The first call establishes a baseline and writes nothing: there is no
   * window before the first tick, and inventing one would date the gap to the
   * epoch.
   */
  tick(sample: CoverageSample, now: number): CollectionGap | null {
    const windowStart = this.lastTickAt;
    this.lastTickAt = now;

    if (windowStart === null) {
      this.recordedAtWindowStart = sample.recorded;
      return null;
    }

    const verdict = classifyWindow(sample, this.recordedAtWindowStart);
    this.recordedAtWindowStart = sample.recorded;

    if (!verdict) {
      // Productive window. Whatever was open is finished and stays as written.
      this.open = null;
      return null;
    }

    if (this.open && this.open.kind === verdict.kind) {
      // Same condition continuing: extend the same row rather than add one.
      this.open = { ...this.open, endedAt: now, reason: verdict.reason };
      return { ...this.open };
    }

    this.open = {
      id: `${this.idPrefix}_${verdict.kind}_${windowStart}`,
      kind: verdict.kind,
      startedAt: windowStart,
      endedAt: now,
      reason: verdict.reason,
    };
    return { ...this.open };
  }
}

/**
 * The window between the last thing this deployment recorded and now.
 *
 * Called once at startup, before the tick loop. A process that sleeps cannot
 * write its own closing gap — it is gone — so the interval is claimed by the
 * next process that boots, which is the only party in a position to see it.
 *
 * `lastKnownActivityMs` is the most recent instant this deployment can show
 * evidence for: the newest recorded gap's end, or the newest signal's decision
 * time, whichever is later. Anything after that and before `now` was not
 * observed, whatever the reason — the process was down, asleep, or not
 * deployed. **`NOT_OBSERVED` is correct for all three**, and deliberately does
 * not try to distinguish them: the union's `MARKET_CLOSED` needs a holiday
 * calendar this codebase does not have, and the failure direction is settled
 * in the docstring above — overstating a gap costs a reader's time, while
 * understating one flatters every rate computed over the window.
 *
 * Returns `null` when there is nothing to claim: no prior activity at all (a
 * first-ever boot has no window behind it, and inventing one would date the
 * gap to the epoch — the same rule `tick()`'s first call follows), or a hole
 * shorter than `minGapMs`, which is an ordinary redeploy rather than an
 * outage worth a row.
 */
export function recoverMissedWindow(
  lastKnownActivityMs: number | null,
  now: number,
  idPrefix = 'gap',
  minGapMs = 120_000,
): CollectionGap | null {
  if (lastKnownActivityMs === null) return null;
  if (!Number.isFinite(lastKnownActivityMs) || lastKnownActivityMs <= 0) return null;
  if (now - lastKnownActivityMs < minGapMs) return null;

  return {
    id: `${idPrefix}_NOT_OBSERVED_${lastKnownActivityMs}`,
    kind: 'NOT_OBSERVED',
    startedAt: lastKnownActivityMs,
    endedAt: now,
    reason:
      `Nothing was recorded between ${new Date(lastKnownActivityMs).toISOString()} ` +
      `and this process starting. The previous process stopped without closing its ` +
      `window — on a host that sleeps when idle that is the ordinary case, and the ` +
      `sleep itself can only be attributed by the next boot. Claimed as ` +
      `NOT_OBSERVED rather than left unattributed, because an unclaimed interval ` +
      `reads as observed to anything computing a rate over it.`,
  };
}

/** Summarise gaps for a status line. Pure, so the projection stays testable. */
export function summariseCoverage(gaps: readonly CollectionGap[]) {
  const total = (kind: GapKind) => gaps
    .filter((g) => g.kind === kind)
    .reduce((ms, g) => ms + Math.max(0, g.endedAt - g.startedAt), 0);

  return {
    gaps: gaps.length,
    // Kept apart in the summary for the same reason they are kept apart in the
    // union: one is an absence of data and the other is data.
    notObservedMs: total('NOT_OBSERVED'),
    observedEmptyMs: total('OBSERVED_EMPTY'),
  };
}
