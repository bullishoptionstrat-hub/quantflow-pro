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
import type { ImpliedDirection } from '../flow-engine/outcome/types';
import { isForwardObservation } from './identity';
import type {
  OutcomeHorizon,
  OutcomeLabelValue,
  SignalRecord,
  SignalStore,
} from './types';

/** Offsets from `decisionAt`. EXPIRY is not graded — see the note in grade(). */
export const HORIZON_OFFSETS_MS: Record<Exclude<OutcomeHorizon, 'EXPIRY'>, number> = {
  M15: 15 * 60_000,
  H1: 60 * 60_000,
  D1: 24 * 60 * 60_000,
};

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
}

export const DEFAULT_GRADER_CONFIG: GraderConfig = {
  flatBandPct: 0.001,
  maxLatenessMs: 30 * 60_000,
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

interface Pending {
  signalKey: string;
  underlying: string;
  decisionAt: number;
  direction: ImpliedDirection;
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
  lastTickAt?: number;
  lastError?: string;
}

export class SignalGrader {
  private readonly pending = new Map<string, Pending>();
  private readonly cfg: GraderConfig;
  private stats: GraderStats = {
    tracked: 0, graded: 0, ungraded: 0, positive: 0, negative: 0, flat: 0,
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
    return { ...this.stats, tracked: this.pending.size };
  }

  /**
   * Begin tracking a recorded signal.
   *
   * Synthetic signals are not tracked. Grading them would burn cycles to
   * produce a hit rate on a random number generator, and the track record
   * excludes them anyway.
   */
  register(rec: SignalRecord): void {
    if (rec.synthetic) return;
    if (this.pending.has(rec.signalKey)) return;

    const dominant = rec.legs[0];
    if (!dominant) return;

    const direction = impliedDirectionOf(
      dominant.side as Parameters<typeof impliedDirectionOf>[0],
      dominant.right,
    );

    this.pending.set(rec.signalKey, {
      signalKey: rec.signalKey,
      underlying: rec.underlying,
      decisionAt: rec.decisionAt,
      direction,
      // Entry mark is taken now, at registration — which is at or just after
      // the decision instant. Taking it later would measure from a price the
      // signal itself may have moved.
      entryMark: this.spot(rec.underlying),
      remaining: new Set<OutcomeHorizon>(['M15', 'H1', 'D1']),
    });
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
            excursion: outcome.excursion,
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
    excursion?: number;
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
        ungradedReason:
          'Side is AMBIGUOUS, so the signal implies no direction. Grading it would ' +
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
    // this grader measures. Past that the denominator of every excursion is a
    // price from before the signal existed, which is wrong rather than
    // imprecise. The bound is `HORIZON_OFFSETS_MS.M15` rather than a constant
    // chosen here: a mark that cannot support the shortest checkpoint cannot
    // support any of them.
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
    // and an excursion measured across two sources, or across an interval that
    // is not the horizon it is filed under, is worth being able to spot later.
    const exitMark = exit.price;
    const rawMove = (exitMark - p.entryMark.price) / p.entryMark.price;
    // Signed in the direction the signal implied: a bearish signal followed by
    // a fall is a positive excursion.
    const excursion = p.direction === 'BULLISH' ? rawMove : -rawMove;

    let label: OutcomeLabelValue;
    if (excursion > this.cfg.flatBandPct) label = 'POSITIVE';
    else if (excursion < -this.cfg.flatBandPct) label = 'NEGATIVE';
    else label = 'FLAT';

    return { label, excursion, exitMark, exitMarkSource: exit.source, exitMarkAt: exit.asOf };
  }
}
