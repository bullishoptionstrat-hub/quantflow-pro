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
 * **`MARKET_CLOSED` used to be refused here outright**, on the grounds that
 * classifying a window as benignly shut "needs a holiday calendar this
 * codebase does not have". That was true when it was written and it is not
 * now: `flow-engine/calendar.ts` is effective-dated, carries a hard `COVERAGE`
 * bound, and answers `UNKNOWN` outside it.
 *
 * The objection it recorded was never to the verdict — it was to *guessing*
 * one. So the rule this module applies is deliberately the narrowest thing
 * that can be established rather than assumed:
 *
 *   - `MARKET_CLOSED` only when **every calendar date the window touches** is
 *     a published holiday or a weekend. A window from Friday afternoon to
 *     Monday morning spans two open sessions and stays an outage.
 *   - `UNKNOWN` — a date past the calendar's coverage — is **not** a closure.
 *     A caller reading "not open" out of "cannot say" is precisely how a
 *     `MARKET_CLOSED` row gets written over a real outage.
 *   - Day granularity only. 02:00 on a Tuesday is a shut market and is still
 *     `NOT_OBSERVED`, because deciding otherwise needs session open times the
 *     calendar does not publish.
 *
 * Every one of those goes the unflattering way, which is the point. An honest
 * `NOT_OBSERVED` over a closed market overstates the gap and costs a reader's
 * time; a `MARKET_CLOSED` over a real outage "does not reduce coverage" (the
 * union's own words) and silently removes the hard cases from every rate
 * computed over the window.
 */
import { closureThroughout } from '../flow-engine/calendar';
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

/** The interval a verdict is about, in epoch ms. */
export interface Window {
  startMs: number;
  endMs: number;
}

/**
 * Classify one window. Pure — the whole point is that this is drivable.
 *
 * Four outcomes, and the middle two are the ones people forget:
 *
 *   - market established shut → MARKET_CLOSED. Benign; does not reduce coverage.
 *   - not collecting          → NOT_OBSERVED. An absence of data.
 *   - collecting, nothing     → OBSERVED_EMPTY. This *is* data: the tape really
 *                               was quiet, and a backtest may use the window.
 *   - collecting, something   → no gap.
 *
 * `window` is required rather than optional. It could have defaulted to "no
 * dates known, so never a closure", which is the safe direction — but a
 * parameter that silently degrades is a parameter callers forget to pass, and
 * the degradation would be invisible: every window would classify exactly as
 * it did before this rule existed. Making it required means a caller that
 * cannot supply an interval has to say so in its own source.
 */
export function classifyWindow(
  sample: CoverageSample,
  recordedAtWindowStart: number,
  window: Window,
): WindowVerdict | null {
  // A productive window is not a gap, whatever the calendar says — and the
  // calendar is asked only about windows that would otherwise be one, so a
  // closure verdict can never displace a real observation.
  const productive = sample.collecting && sample.recorded > recordedAtWindowStart;
  if (productive) return null;

  const closure = closureThroughout(window.startMs, window.endMs);
  if (closure.closed) {
    return {
      kind: 'MARKET_CLOSED',
      reason:
        `Market established shut for the whole window: ${closure.basis}. ` +
        'Benign — this does not reduce coverage. Established from the ' +
        'effective-dated calendar in src/flow-engine/calendar.ts, never inferred ' +
        'from a date it cannot answer for.',
    };
  }

  if (!sample.collecting) {
    return {
      kind: 'NOT_OBSERVED',
      // The store refuses a reason under 10 characters, because a gap's reason
      // is read months later by someone deciding whether a window is usable.
      reason: `Not collecting: ${sample.reason}`,
    };
  }
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

    const verdict = classifyWindow(sample, this.recordedAtWindowStart, {
      startMs: windowStart, endMs: now,
    });
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
 * deployed. **`NOT_OBSERVED` does not try to distinguish those three**, and
 * that is deliberate: from here they are the same fact.
 *
 * It *does* ask the calendar, on the same terms `classifyWindow` does — every
 * date the hole touches must be an established closure. In practice that
 * almost never fires for a recovery window, because a hole long enough to be
 * worth a row usually reaches into an open session at one end or the other,
 * and reaching into one is enough to keep it an outage. It is asked anyway
 * rather than hardcoded to `NOT_OBSERVED`, because two windows classified by
 * two different rules is how the two stores' `trackRecord()` drifted.
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

  const closure = closureThroughout(lastKnownActivityMs, now);
  if (closure.closed) {
    return {
      id: `${idPrefix}_MARKET_CLOSED_${lastKnownActivityMs}`,
      kind: 'MARKET_CLOSED',
      startedAt: lastKnownActivityMs,
      endedAt: now,
      reason:
        `Nothing was recorded between ${new Date(lastKnownActivityMs).toISOString()} ` +
        `and this process starting, and the market was established shut for the ` +
        `whole interval: ${closure.basis}. Benign — this does not reduce coverage.`,
    };
  }

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

/**
 * Summarise gaps for a status line. Pure, so the projection stays testable.
 *
 * **Every member of `GapKind` gets a bucket, and `unclassifiedMs` catches any
 * that does not.** Before `MARKET_CLOSED` was emittable this function reported
 * two buckets against a three-member union, which was harmless only because
 * the third was never constructed. The moment it was, a closure's minutes
 * would have vanished from the summary while still counting in `gaps` — a
 * breakdown that does not add up to the total beside it, which is the defect
 * `scoreBreakdown`'s silent clamp already cost this repo once.
 *
 * `totalMs` is computed independently of the buckets rather than as their sum,
 * so a kind added to the union and forgotten here shows up as a residual
 * instead of being absorbed.
 */
export function summariseCoverage(gaps: readonly CollectionGap[]) {
  const span = (g: CollectionGap) => Math.max(0, g.endedAt - g.startedAt);
  const total = (kind: GapKind) => gaps
    .filter((g) => g.kind === kind)
    .reduce((ms, g) => ms + span(g), 0);

  const totalMs = gaps.reduce((ms, g) => ms + span(g), 0);
  // Kept apart for the same reason they are kept apart in the union: one is an
  // absence of data, one is data, and one is benign and does not reduce
  // coverage at all.
  const notObservedMs = total('NOT_OBSERVED');
  const observedEmptyMs = total('OBSERVED_EMPTY');
  const marketClosedMs = total('MARKET_CLOSED');

  return {
    gaps: gaps.length,
    notObservedMs,
    observedEmptyMs,
    marketClosedMs,
    totalMs,
    /**
     * Minutes in a gap row whose kind this summary has no bucket for.
     *
     * Always zero today. It is published rather than asserted because the
     * failure it guards against is a `GapKind` member added upstream and not
     * added here, and a number a reader can see beats a comment asking them to
     * remember.
     */
    unclassifiedMs: totalMs - notObservedMs - observedEmptyMs - marketClosedMs,
  };
}

/**
 * Every gap row a process knows about, and the totals over them.
 *
 * `summariseCoverage` was exported, tested, and **called by nothing** — the
 * class of defect this module has now produced four times (`recordGap` with no
 * writer, `listUngraded` with no caller, `sourceNotes` with no reader). A
 * summary nobody reads cannot tell an operator that 3% of a span was claimed
 * when the real figure is 97%, which is the measurement that made
 * `recoverMissedWindow` necessary.
 *
 * It lives here rather than as module state in `ingestion/index.ts` for the
 * reason `classifyWindow` is pure: the interesting part is the de-duplication,
 * and a rule that cannot be driven is a rule nothing checks.
 */
export class CoverageLedger {
  /**
   * Keyed by id rather than appended, because an open gap is re-recorded as it
   * extends — `recordGap` upserts on id — so appending would count one window
   * once per tick and report an outage many times its real length. That is the
   * opposite of the flattering direction, and a wrong number either way is a
   * wrong number.
   */
  private readonly rows = new Map<string, CollectionGap>();
  private evicted = 0;

  /**
   * @param max A bound, because this lives for the life of the process.
   *   Nothing realistic approaches it (the live project carried nine rows
   *   across a 4,160-minute span), but an unbounded map fed by a 60-second
   *   timer is the enrichment cache's defect with a different key.
   */
  constructor(private readonly max = 2_000) {}

  note(gap: CollectionGap): void {
    // Delete first so a re-recorded window moves to the end of the insertion
    // order. Without it an extending gap keeps its original position and is
    // evicted while still open, which would drop the row most likely to
    // matter.
    this.rows.delete(gap.id);
    this.rows.set(gap.id, gap);
    while (this.rows.size > this.max) {
      const oldest = this.rows.keys().next().value;
      if (oldest === undefined) break;
      this.rows.delete(oldest);
      this.evicted += 1;
    }
  }

  /**
   * The totals, with the eviction count beside them.
   *
   * `rowsEvicted` non-zero means these are totals over a retained subset and
   * not over the record — the note `memoryStore.trackRecord()` carries, for
   * the same reason.
   */
  summary() {
    return { ...summariseCoverage([...this.rows.values()]), rowsEvicted: this.evicted };
  }
}
