/**
 * QuantFlow Pro — outcome grading
 *
 * Grades every recorded signal at fixed horizons after its DECISION time, and
 * writes the result into the durable record.
 *
 * Three deliberate choices, each of which makes the numbers smaller and more
 * believable:
 *
 * 1. **Checkpoints are scheduled from `decisionAt`, not from the first print.**
 *    Scheduling from the first print would start the clock before the signal
 *    existed and hand the measurement the burst duration plus the feed latency
 *    as free information.
 *
 * 2. **Only strictly-forward observations count.** `isForwardObservation` uses
 *    `>`, so a mark taken at exactly the decision instant is rejected. That is
 *    where a one-tick lookahead would otherwise enter.
 *
 * 3. **Grading is on the UNDERLYING, and says so.** The richer measurement is
 *    the contract's own mark, but this deployment has no live per-contract
 *    mark for an arbitrary strike — inventing one from a stale chain snapshot
 *    would produce a precise, wrong number. Underlying movement in the
 *    signal's implied direction is what is actually observable here, so it is
 *    what is measured, and every row records that basis.
 *
 * A signal that cannot be graded is written as UNGRADED with a reason. It is
 * never dropped: dropping the hard cases is how a hit rate drifts upward
 * without anyone editing a number.
 */
import { impliedDirectionOf } from '../flow-engine/outcome/types';
import { GRADED_HORIZONS, HORIZON_NOMINAL_MS } from './types';
import type { ImpliedDirection } from '../flow-engine/outcome/types';
import { isForwardObservation } from './identity';
import type {
  GradedHorizon,
  OutcomeHorizon,
  OutcomeLabelValue,
  SignalRecord,
  SignalStore,
} from './types';

/**
 * Offsets from `decisionAt`. EXPIRY is not graded — see the note in grade().
 *
 * The values live in `types.ts` as `HORIZON_NOMINAL_MS` now that
 * `/api/track-record` needs them too — it compares the interval a row was
 * measured over against the horizon it is filed under. Re-exported under this
 * name because the grader is where the offsets are *applied*, and one table of
 * horizon lengths beats two that can disagree.
 */
export const HORIZON_OFFSETS_MS = HORIZON_NOMINAL_MS;

export interface GraderConfig {
  /**
   * Moves smaller than this (fractional, so 0.001 = 0.1%) are FLAT rather than
   * a directional hit. Without a dead band, noise at the fourth decimal place
   * gets counted as a win roughly half the time and the hit rate converges on
   * 50% for reasons that have nothing to do with the signal.
   */
  flatBandPct: number;
  /**
   * A checkpoint more than this far past due is graded UNGRADED rather than
   * against a much later price. The process sleeps on a free tier; waking up
   * six hours late and grading M15 against a six-hour-old move would be a
   * fabricated measurement.
   */
  maxLatenessMs: number;
  /**
   * How far AFTER the decision instant an entry mark may be stamped.
   *
   * Not zero, because the live path cannot achieve zero: `register()` runs
   * once the recorder's write resolves, so the mark is fetched a short moment
   * after `decisionAt` and a vendor stamp from that moment is the honest
   * answer to "what was the price when this signal was decided". Refusing it
   * outright would make every real signal UNGRADED.
   *
   * Not unbounded either, which is what it was: the age is a subtraction, so a
   * mark from the future made it negative and sailed through the too-early
   * guard — the same hole `nbbo.ts` had when a quote stamped after the trade
   * produced a negative age. Harmless while the gap was recording latency;
   * catastrophic the moment a restart resumes a signal from hours ago and
   * prices its entry at today's close.
   *
   * 60s is three orders of magnitude below the shortest horizon, so a mark
   * inside it cannot materially move an M15 measurement, and it is far above
   * any plausible recording latency or vendor clock skew. This is a named
   * tolerance rather than a derived bound because the quantity it covers —
   * registration latency — has no proxy anywhere on the row. Recovery does not
   * rely on it: that path never re-takes a mark at all, so this is the second
   * line, not the first.
   */
  maxEntryMarkLookaheadMs: number;
}

export const DEFAULT_GRADER_CONFIG: GraderConfig = {
  flatBandPct: 0.001,
  maxLatenessMs: 30 * 60_000,
  maxEntryMarkLookaheadMs: 60_000,
};

/**
 * A price, and where it came from.
 *
 * The provenance is part of the value rather than a second argument, so it is
 * **structurally impossible to record a mark without knowing its source**. The
 * previous shape was a bare `number | undefined`, and every graded outcome in
 * this repo's history therefore carries a price whose origin is recoverable
 * only by knowing which vendor happened to be wired in on the day — which is
 * the same class of unrecorded assumption as "a vendor honours the key it
 * issued".
 *
 * `rightsClass` travels with it because a mark from an `UNVERIFIED` source and
 * one from a `PERMITTED` source are different evidence, and a track record
 * built from a mixture should be able to say which rows are which.
 */
export interface Mark {
  price: number;
  /** Connector source string, e.g. `twelvedata`. */
  source: string;
  /** Its PERSIST standing in the mode that resolved it. Never `PROHIBITED`. */
  rightsClass: string;
  /**
   * When this price was true, on the **vendor's** clock.
   *
   * The same argument as `source`, one step further: provenance made it
   * impossible to record a mark without knowing where it came from, and this
   * makes it impossible to record one without knowing *when*. Without it the
   * grader measured a move between two prices having never established that
   * one came after the other — invisible while the cache refreshed every 60
   * seconds, and reachable the moment it refreshed every 19 minutes.
   *
   * It is the vendor's stamp and not our receipt time, because the question is
   * when the market was at this price, not when we heard about it. Off-hours
   * those differ by hours, and the receipt-time answer is the flattering one.
   */
  asOf: number;
}

/** Current mark for an underlying, or undefined when not observable. */
export type MarkLookup = (underlying: string) => Mark | undefined;

/** @deprecated The bare-number shape. Kept only as a name for older callers. */
export type SpotLookup = MarkLookup;

/**
 * The leg carrying the most premium, which is the one the signal is about.
 *
 * Mirrors `dominantLegOf()` in the flow-engine module. Duplicated rather than
 * imported because it operates on `StoredLeg` — the persisted shape — and the
 * vendored engine must stay byte-identical to its module. Held to the module's
 * answer by a test.
 */
export function dominantStoredLeg<T extends { totalPremium: number }>(
  legs: readonly T[],
): T | undefined {
  let best = legs[0];
  for (const leg of legs) {
    if (best === undefined || leg.totalPremium > best.totalPremium) best = leg;
  }
  return best;
}

/**
 * Structures that express no direction, and so cannot be graded as though
 * they did.
 *
 * Read off the engine's own `spreadGuess` rather than re-derived here, so
 * there is one classifier and not two. A straddle or strangle is long (or
 * short) both wings — a position on movement. Its "direction" is not merely
 * hard to read, it does not exist, and a directional hit rate computed over a
 * population containing them is measuring something else.
 *
 * A risk reversal IS directional (long one wing, short the other) and is
 * deliberately absent from this list. So is `UNKNOWN`: an unclassified
 * structure is not established to be non-directional, and refusing everything
 * the classifier could not name would silently empty the track record.
 */
const UNDIRECTED_STRUCTURES = new Set(['STRADDLE_STRANGLE']);

export function undirectedStructure(
  rec: { spreadGuess?: string },
): boolean {
  return rec.spreadGuess !== undefined && UNDIRECTED_STRUCTURES.has(rec.spreadGuess);
}

/** What a restart recovers about a signal whose grading was interrupted. */
export interface ResumedState {
  /** Horizons with no live outcome row yet. */
  remaining: readonly GradedHorizon[];
  /** The entry mark observed before the restart, when one was recorded. */
  entryMark?: Mark;
}

export interface RecoveryReport {
  examined: number;
  resumed: number;
  /** Already graded at every horizon the grader writes. */
  alreadyComplete: number;
  /** Of those resumed, how many recovered a usable entry mark. */
  withEntryMark: number;
  failed: number;
}

/**
 * Rebuild the entry mark from an outcome row that already recorded one.
 *
 * The three persisted fields are price, source and stamp; `rightsClass` is the
 * fourth member of `Mark` and is not on the row, so it is resolved by the
 * caller from the live registry. When the caller cannot name a class for that
 * source, the mark is refused rather than stamped with a placeholder: a
 * recovered mark whose rights standing is invented is precisely the kind of
 * unrecorded assumption `Mark.source` was introduced to eliminate.
 */
export function recoverEntryMark(
  outs: readonly { entryMark?: number; entryMarkSource?: string; entryMarkAt?: number }[],
  rightsFor: (markSource: string) => string | undefined,
): Mark | undefined {
  for (const o of outs) {
    if (o.entryMark === undefined || !(o.entryMark > 0)) continue;
    if (!o.entryMarkSource) continue;
    if (o.entryMarkAt === undefined || !Number.isFinite(o.entryMarkAt) || o.entryMarkAt <= 0) {
      continue;
    }
    const rightsClass = rightsFor(o.entryMarkSource);
    if (!rightsClass) continue;
    return {
      price: o.entryMark,
      source: o.entryMarkSource,
      rightsClass,
      asOf: o.entryMarkAt,
    };
  }
  return undefined;
}

interface Pending {
  signalKey: string;
  underlying: string;
  decisionAt: number;
  direction: ImpliedDirection;
  /** Why the direction is NONE, so the UNGRADED reason can say which. */
  undirected: boolean;
  spreadGuess?: string;
  entryMark?: Mark;
  /** Horizons still to grade. */
  remaining: Set<OutcomeHorizon>;
}

export interface GraderStats {
  tracked: number;
  graded: number;
  ungraded: number;
  positive: number;
  negative: number;
  flat: number;
  /**
   * Checkpoints whose write threw, summed over the life of the process.
   *
   * Counted because every other number here moves only on a *successful*
   * write, so a deployment where the store refuses everything reads exactly
   * like one with nothing to grade: all zeros. That is not hypothetical — the
   * live database was missing `entry_mark_at`/`exit_mark_at` until
   * 2026-09-21, so every outcome insert would have failed `42703` and the
   * health payload would have said the same thing it says on a quiet tape.
   *
   * `lastError` carries the message but is scrubbed from the unauthenticated
   * `/api/health`, and is only ever the *most recent* one; this is the counter
   * that survives the scrub and distinguishes "nothing came due" from
   * "nothing could be written".
   */
  writeFailures: number;
  /** Checkpoints currently awaiting a retry after a failed write. */
  writeRetrying: number;
  lastTickAt?: number;
  lastError?: string;
}

export class SignalGrader {
  private readonly pending = new Map<string, Pending>();
  private readonly cfg: GraderConfig;
  private stats: GraderStats = {
    tracked: 0, graded: 0, ungraded: 0, positive: 0, negative: 0, flat: 0,
    writeFailures: 0, writeRetrying: 0,
  };

  constructor(
    private readonly store: SignalStore,
    private readonly spot: MarkLookup,
    config: Partial<GraderConfig> = {},
    private readonly now: () => number = () => Date.now(),
  ) {
    this.cfg = { ...DEFAULT_GRADER_CONFIG, ...config };
  }

  getStats(): GraderStats {
    return {
      ...this.stats,
      tracked: this.pending.size,
      writeRetrying: this.countRetrying(),
    };
  }

  /**
   * Checkpoints that have fallen due and still have no row.
   *
   * Derived rather than tracked as a counter, so it cannot drift from the map
   * it describes: a horizon leaves this number by being written, which is the
   * only way it leaves `remaining`. Measured against the last tick's clock
   * rather than `Date.now()`, because a checkpoint is not overdue until a tick
   * has actually looked at it.
   */
  private countRetrying(): number {
    const at = this.stats.lastTickAt;
    if (at === undefined) return 0;
    let n = 0;
    for (const p of this.pending.values()) {
      for (const h of p.remaining) {
        const off = HORIZON_OFFSETS_MS[h as 'M15' | 'H1' | 'D1'];
        if (off !== undefined && at >= p.decisionAt + off) n++;
      }
    }
    return n;
  }

  /**
   * One line on the first failure, then every hundredth.
   *
   * A store that is refusing everything fails once per checkpoint per tick, so
   * a line each is its own outage — the same reasoning as `noteUnparsedFrame`,
   * which logs the first and then every five hundredth. The counter on
   * `/api/health` is the channel meant to be read; this is for the process log.
   */
  private logWriteFailure(signalKey: string, horizon: OutcomeHorizon): void {
    const n = this.stats.writeFailures;
    if (n === 1 || n % 100 === 0) {
      console.error(
        `[grader] outcome write failed (${n} so far) for ${signalKey.slice(0, 12)}…/${horizon}; ` +
          `the checkpoint stays pending and will be retried: ${this.stats.lastError}`,
      );
    }
  }

  /**
   * Begin tracking a recorded signal.
   *
   * Synthetic signals are not tracked. Grading them would burn cycles to
   * produce a hit rate on a random number generator, and the track record
   * excludes them anyway.
   */
  register(rec: SignalRecord, resumed?: ResumedState): void {
    if (rec.synthetic) return;
    if (this.pending.has(rec.signalKey)) return;

    // The DOMINANT leg — highest premium — not `legs[0]`.
    //
    // The engine stores legs in the order their contract+side groups were
    // first seen, so `legs[0]` is whichever leg printed first. On the fixture
    // this repo already documents — a bought $102k SPY call alongside a bought
    // $2.2k put, the small put printing five milliseconds earlier — the
    // grader took its direction from the $2.2k put. Measured: a +2% move in
    // the underlying, which is what the $102k call was positioned for, graded
    // NEGATIVE.
    //
    // `dominantLegOf()` was written for exactly this and lives in the
    // flow-engine module, which nothing in `src/` imports — so the fix landed
    // in the deprecated standalone tracker and the production grader kept the
    // defect. The rule is reimplemented here rather than imported because the
    // record's `StoredLeg` is a different type from the engine's leg, and
    // `vendorMirror.test.ts` holds the engine copy byte-identical to its
    // module. `graderDirection.test.ts` holds the two to the same answer.
    const dominant = dominantStoredLeg(rec.legs);
    if (!dominant) return;

    // A structure whose direction is undefined is not graded directionally.
    //
    // A long strangle is two long wings: a bet on movement, not on direction.
    // Taking its "direction" from the larger leg produces a confident
    // bullish/bearish label for a position that expresses neither, and pools
    // it into a directional hit rate. The engine already classifies the
    // structure; this reads that classification instead of overriding it.
    const undirected = undirectedStructure(rec);
    const direction = undirected ? 'NONE' : impliedDirectionOf(
      dominant.side as Parameters<typeof impliedDirectionOf>[0],
      dominant.right,
    );

    const remaining = new Set<OutcomeHorizon>(
      resumed ? resumed.remaining : GRADED_HORIZONS,
    );
    if (remaining.size === 0) return;

    this.pending.set(rec.signalKey, {
      signalKey: rec.signalKey,
      underlying: rec.underlying,
      decisionAt: rec.decisionAt,
      direction,
      undirected,
      spreadGuess: rec.spreadGuess,
      // Live path: the entry mark is taken now, at registration — at or just
      // after the decision instant. Taking it later would measure from a price
      // the signal itself may have moved.
      //
      // Recovery path: taking a mark *now* would be a price from long after
      // the decision, which is lookahead of exactly the kind `decisionAt`
      // exists to prevent. So a resumed signal uses only the entry mark that
      // was actually observed and persisted at the time; when none was, it
      // carries none and grades UNGRADED with the reason. Inventing one here
      // would turn a lost checkpoint into a confident, wrong measurement.
      entryMark: resumed ? resumed.entryMark : this.spot(rec.underlying),
      remaining,
    });
  }

  /**
   * Re-register signals whose grading is unfinished, after a restart.
   *
   * `pending` is process memory. Every checkpoint scheduled before a restart
   * was silently abandoned: the row stayed in `signal_history` with no outcome
   * and nothing ever looked at it again. `listUngraded()` was implemented in
   * both stores, declared on the interface, exercised by two tests — and
   * called by nothing in `src/`. This is that caller.
   *
   * Two properties make recovery honest rather than merely productive:
   *
   *   - **A horizon already graded is not graded again.** The live outcome
   *     rows say which are done; only the remainder is rescheduled. Outcomes
   *     are append-only, so a second write would not overwrite the first — it
   *     would sit beside it as a second reading of one checkpoint.
   *
   *   - **An entry mark is never re-taken.** It is recovered from an outcome
   *     row that already recorded one, or it is absent. A signal that was
   *     never graded at any horizon before the restart therefore has no entry
   *     mark, and grades UNGRADED. That is the honest answer, and it makes the
   *     restart loss *visible* in the record instead of leaving the signal to
   *     vanish — the same argument `collection_gaps` makes about outages.
   */
  async recover(
    limit = 500,
    rightsFor: (markSource: string) => string | undefined = () => undefined,
  ): Promise<RecoveryReport> {
    const report: RecoveryReport = {
      examined: 0, resumed: 0, alreadyComplete: 0, withEntryMark: 0, failed: 0,
    };

    // The window: how far back a checkpoint can be and still be worth
    // resuming. Derived, not picked — the longest horizon this grader
    // schedules, plus the lateness it will still grade within. A signal older
    // than that has no checkpoint left that could produce anything but
    // UNGRADED, and scanning for it would make boot a function of how much
    // history exists rather than of how much is pending.
    const since = this.now()
      - (HORIZON_OFFSETS_MS.D1 + this.cfg.maxLatenessMs);

    let open: SignalRecord[];
    try {
      open = await this.store.listUngraded(limit, since);
    } catch (err) {
      this.stats.lastError = err instanceof Error ? err.message : String(err);
      report.failed++;
      return report;
    }

    for (const rec of open) {
      report.examined++;
      try {
        const outs = await this.store.listOutcomes(rec.signalKey);
        const done = new Set(outs.map((o) => o.horizon));
        const remaining = GRADED_HORIZONS.filter((h) => !done.has(h));
        if (remaining.length === 0) { report.alreadyComplete++; continue; }

        const entryMark = recoverEntryMark(outs, rightsFor);
        if (entryMark) report.withEntryMark++;
        this.register(rec, { remaining, entryMark });
        report.resumed++;
      } catch (err) {
        this.stats.lastError = err instanceof Error ? err.message : String(err);
        report.failed++;
      }
    }
    return report;
  }

  /**
   * Grade every checkpoint that has fallen due. Safe to call on a timer.
   * Returns the number of outcomes written.
   */
  async tick(): Promise<number> {
    const now = this.now();
    this.stats.lastTickAt = now;
    let written = 0;

    for (const p of [...this.pending.values()]) {
      for (const horizon of [...p.remaining]) {
        const dueAt = p.decisionAt + HORIZON_OFFSETS_MS[horizon as 'M15' | 'H1' | 'D1'];
        if (now < dueAt) continue;

        try {
          const outcome = this.grade(p, horizon, dueAt, now);
          await this.store.writeOutcome({
            signalKey: p.signalKey,
            horizon,
            label: outcome.label,
            directionalReturnAtHorizon: outcome.directionalReturnAtHorizon,
            entryMark: p.entryMark?.price,
            entryMarkSource: p.entryMark?.source,
            entryMarkAt: p.entryMark?.asOf,
            exitMark: outcome.exitMark,
            exitMarkSource: outcome.exitMarkSource,
            exitMarkAt: outcome.exitMarkAt,
            dueAt,
            evaluatedAt: now,
            ungradedReason: outcome.ungradedReason,
            revision: 1,
          });
          written++;
          if (outcome.label === 'UNGRADED') this.stats.ungraded++;
          else {
            this.stats.graded++;
            if (outcome.label === 'POSITIVE') this.stats.positive++;
            else if (outcome.label === 'NEGATIVE') this.stats.negative++;
            else this.stats.flat++;
          }
        } catch (err) {
          this.stats.lastError = err instanceof Error ? err.message : String(err);
          this.stats.writeFailures++;
          // Keep the horizon pending. It used to be deleted here — the
          // `delete` sat *outside* this try — so a checkpoint whose write
          // threw was discarded in the same breath as one that succeeded: no
          // row, no retry, no incident, and not one counter moved. The
          // failures this actually catches are transient (a network blip, a
          // rate limit, a store briefly refusing) or operator-fixable (a
          // missing column, a revoked key), and both are recoverable on a
          // later tick. Dropping the checkpoint makes them permanent for the
          // life of the process, and grading is exactly the thing that cannot
          // be redone later from a price that has moved on.
          //
          // Retrying forever is deliberate over a retry cap: a cap is a second
          // way to lose a checkpoint silently, and `recover()` already bounds
          // the set to what the *store* still reports ungraded, so a restart
          // re-derives this from durable state rather than from this map.
          this.logWriteFailure(p.signalKey, horizon);
          continue;
        }
        p.remaining.delete(horizon);
      }
      if (p.remaining.size === 0) this.pending.delete(p.signalKey);
    }
    return written;
  }

  private grade(
    p: Pending,
    horizon: OutcomeHorizon,
    dueAt: number,
    now: number,
  ): {
    label: OutcomeLabelValue;
    directionalReturnAtHorizon?: number;
    exitMark?: number;
    exitMarkSource?: string;
    exitMarkAt?: number;
    ungradedReason?: string;
  } {
    // An AMBIGUOUS side yields no implied direction, and a signal with no
    // direction has nothing to be right or wrong about. This is the single
    // largest source of UNGRADED rows, and it should be: the engine refuses to
    // guess a side without a fresh NBBO, so the grader inherits that refusal
    // rather than quietly assuming "buy".
    if (p.direction === 'NONE') {
      return {
        label: 'UNGRADED',
        ungradedReason: p.undirected
          ? `Structure is ${p.spreadGuess}, which expresses no direction — it is a ` +
            `position on movement, not on which way. Grading it bullish or bearish ` +
            `from its larger leg would put a directionless position into a ` +
            `directional hit rate.`
          : 'Side is AMBIGUOUS, so the signal implies no direction. Grading it would ' +
            'require assuming a side the engine explicitly declined to infer.',
      };
    }

    if (p.entryMark === undefined || !(p.entryMark.price > 0)) {
      return {
        label: 'UNGRADED',
        ungradedReason:
          `No usable entry mark for ${p.underlying} at the decision instant. The gap ` +
          'is recorded rather than interpolated from a neighbouring quote.',
      };
    }

    // An entry mark may legitimately predate the decision — it is the last
    // price before that instant — but not by more than the shortest horizon
    // this grader measures. Past that the denominator of every return is a
    // price from before the signal existed, which is wrong rather than
    // imprecise. The bound is `HORIZON_OFFSETS_MS.M15` rather than a constant
    // chosen here: a mark that cannot support the shortest checkpoint cannot
    // support any of them.
    // An entry mark stamped AFTER the decision is lookahead: the return's
    // denominator would be a price the signal itself may already have moved.
    // Only the too-early direction was guarded, because `entryAge` is a
    // subtraction and a mark from the future makes it negative — the same
    // shape as the NBBO staleness hole, where a quote stamped after the trade
    // produced a negative age and sailed through. Invisible while the mark was
    // taken microseconds after the decision; systematic the moment a restart
    // resumes a signal from hours ago.
    //
    // The cost is stated rather than tuned away: a vendor clock running ahead
    // of ours turns honest marks into UNGRADED rows. That is the safe
    // direction, and it is the one this codebase takes everywhere else that
    // two clocks have to be ordered.
    const lookahead = p.entryMark.asOf - p.decisionAt;
    if (lookahead > this.cfg.maxEntryMarkLookaheadMs) {
      return {
        label: 'UNGRADED',
        ungradedReason:
          `Entry mark for ${p.underlying} is stamped ${Math.round(lookahead / 1000)}s ` +
          `AFTER the decision instant, beyond the tolerance for registration ` +
          `latency. It is a price from after the signal, so measuring from it ` +
          `would credit the signal with information it did not have.`,
      };
    }

    const entryAge = p.decisionAt - p.entryMark.asOf;
    if (entryAge > HORIZON_OFFSETS_MS.M15) {
      return {
        label: 'UNGRADED',
        ungradedReason:
          `Entry mark for ${p.underlying} is stamped ${Math.round(entryAge / 60_000)} ` +
          `minutes before the decision instant, which is longer than the shortest ` +
          `horizon this grader measures. The move would be measured from a price ` +
          `that predates the signal.`,
      };
    }

    if (!isForwardObservation(p.decisionAt, now)) {
      return {
        label: 'UNGRADED',
        ungradedReason:
          'Observation is not strictly after the decision instant, so it cannot be ' +
          'used as a forward measurement.',
      };
    }

    const lateness = now - dueAt;
    if (lateness > this.cfg.maxLatenessMs) {
      return {
        label: 'UNGRADED',
        ungradedReason:
          `Checkpoint ${horizon} came due ${Math.round(lateness / 60_000)} minutes ago; ` +
          `the process was not running to observe it. Grading against the current ` +
          `price would report a much later move under an earlier horizon's label.`,
      };
    }

    const exit = this.spot(p.underlying);
    if (exit === undefined || !(exit.price > 0)) {
      return {
        label: 'UNGRADED',
        ungradedReason:
          `No usable mark for ${p.underlying} at the ${horizon} checkpoint.`,
      };
    }

    // The checkpoint is observed by the *mark's* clock, not by ours. `now` is
    // when this tick ran; `exit.asOf` is when the price it read was true, and a
    // cache refreshed every 19 minutes routinely hands back a price stamped
    // before the checkpoint it is being used to grade. At M15 that price can
    // predate `decisionAt` itself, so the "move" is measured backwards across
    // the signal.
    if (exit.asOf < dueAt) {
      return {
        label: 'UNGRADED',
        ungradedReason:
          `The ${horizon} mark for ${p.underlying} is stamped ` +
          `${Math.round((dueAt - exit.asOf) / 60_000)} minutes before the checkpoint ` +
          `came due, so it never observed it. The mark source refreshes more slowly ` +
          `than this horizon is long.`,
      };
    }

    // Same rule as `isForwardObservation`, applied to the prices rather than to
    // the process clock: two marks with the same stamp measure no interval, and
    // an exit stamped before the entry measures one backwards.
    if (!(exit.asOf > p.entryMark.asOf)) {
      return {
        label: 'UNGRADED',
        ungradedReason:
          `The ${horizon} mark for ${p.underlying} is not stamped after the entry ` +
          `mark, so no forward interval was measured between them.`,
      };
    }

    // Both marks are recorded with their source and their stamp. All four can
    // differ — a vendor can fall out between registration and a checkpoint —
    // and a return measured across two sources, or across an interval that
    // is not the horizon it is filed under, is worth being able to spot later.
    const exitMark = exit.price;
    const rawMove = (exitMark - p.entryMark.price) / p.entryMark.price;
    // Signed in the direction the signal implied: a bearish signal followed by
    // a fall is a positive return.
    //
    // This is the ENDPOINT return, not an excursion. Only two prices are ever
    // observed — one at each mark — so the path between them is unseen, and the
    // furthest favourable point on that path is not available to this grader at
    // any price. See `OutcomeRecord.directionalReturnAtHorizon`.
    const directionalReturnAtHorizon = p.direction === 'BULLISH' ? rawMove : -rawMove;

    let label: OutcomeLabelValue;
    if (directionalReturnAtHorizon > this.cfg.flatBandPct) label = 'POSITIVE';
    else if (directionalReturnAtHorizon < -this.cfg.flatBandPct) label = 'NEGATIVE';
    else label = 'FLAT';

    return {
      label,
      directionalReturnAtHorizon,
      exitMark,
      exitMarkSource: exit.source,
      exitMarkAt: exit.asOf,
    };
  }
}
