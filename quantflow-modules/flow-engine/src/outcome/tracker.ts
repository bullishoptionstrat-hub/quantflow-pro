/**
 * QuantFlow Outcome Tracker
 *
 * Lifecycle per signal:
 *   register(signal) — snapshot entry marks, schedule M15 / H1 / D1
 *                      (+ EXPIRY when within horizon)
 *   evaluateDue(now) — fill any checkpoints whose time has passed;
 *                      when the last one completes, assign the final label
 *   report()         — honest aggregate hit-rates by signal kind
 *
 * Honesty contracts:
 *   - AMBIGUOUS-side signals and signals with no usable entry mark are
 *     UNGRADED, and UNGRADED is reported, never hidden.
 *   - Missing marks at a checkpoint are recorded as gaps, not interpolated.
 *   - Labels measure what happened; they recommend nothing.
 */
import { ClassifiedSignal } from "../types.js";
import {
  CHECKPOINT_OFFSETS_MS,
  CheckpointResult,
  DEFAULT_OUTCOME_CONFIG,
  impliedDirectionOf,
  OutcomeLabel,
  OutcomeStore,
  OutcomeTrackerConfig,
  PriceLookup,
  TrackedSignal,
} from "./types.js";

export class OutcomeTracker {
  private readonly cfg: OutcomeTrackerConfig;

  constructor(
    private readonly store: OutcomeStore,
    private readonly prices: PriceLookup,
    config: Partial<OutcomeTrackerConfig> = {},
  ) {
    this.cfg = { ...DEFAULT_OUTCOME_CONFIG, ...config };
  }

  async register(signal: ClassifiedSignal): Promise<TrackedSignal> {
    const dominant = signal.legs[0];
    if (!dominant) throw new Error(`Signal ${signal.id} has no legs`);

    const entryMarks = await this.prices({
      contractSymbol: dominant.contract.symbol,
      underlying: signal.underlying,
      ts: signal.ts,
    });

    const checkpoints: CheckpointResult[] = (
      Object.entries(CHECKPOINT_OFFSETS_MS) as Array<
        [keyof typeof CHECKPOINT_OFFSETS_MS, number]
      >
    ).map(([key, off]) => ({ key, dueTs: signal.ts + off }));

    const expiryTs = Date.parse(`${dominant.contract.expiry}T20:00:00Z`);
    if (
      !Number.isNaN(expiryTs) &&
      expiryTs > signal.ts &&
      expiryTs - signal.ts <= this.cfg.maxExpiryHorizonMs
    ) {
      checkpoints.push({ key: "EXPIRY", dueTs: expiryTs });
    }
    checkpoints.sort((a, b) => a.dueTs - b.dueTs);

    const tracked: TrackedSignal = {
      signalId: signal.id,
      signal,
      impliedDirection: impliedDirectionOf(signal.side, dominant.contract.right),
      entry: {
        ts: signal.ts,
        contractMark: entryMarks.contractMark,
        underlyingPrice: entryMarks.underlyingPrice,
      },
      checkpoints,
    };
    await this.store.upsert(tracked);
    return tracked;
  }

  /** Evaluate all open signals' due checkpoints. Returns newly closed ones. */
  async evaluateDue(now: number): Promise<TrackedSignal[]> {
    const closed: TrackedSignal[] = [];
    for (const t of await this.store.listOpen()) {
      let dirty = false;
      const dominant = t.signal.legs[0];
      if (!dominant) continue;

      for (const cp of t.checkpoints) {
        if (cp.snapshot !== undefined || cp.dueTs > now) continue;
        const marks = await this.prices({
          contractSymbol: dominant.contract.symbol,
          underlying: t.signal.underlying,
          ts: cp.dueTs,
        });
        cp.snapshot = { ts: cp.dueTs, ...marks };
        if (marks.contractMark !== undefined && t.entry.contractMark) {
          cp.contractReturnPct =
            (marks.contractMark - t.entry.contractMark) / t.entry.contractMark;
        }
        if (marks.underlyingPrice !== undefined && t.entry.underlyingPrice) {
          cp.underlyingMovePct =
            (marks.underlyingPrice - t.entry.underlyingPrice) / t.entry.underlyingPrice;
        }
        dirty = true;
      }

      const allDone = t.checkpoints.every((c) => c.snapshot !== undefined);
      if (allDone && t.finalLabel === undefined) {
        t.finalLabel = this.grade(t);
        t.directionCorrectAtD1 = this.directionCorrect(t);
        t.closedAt = now;
        closed.push(t);
        dirty = true;
      }
      if (dirty) await this.store.upsert(t);
    }
    return closed;
  }

  private grade(t: TrackedSignal): OutcomeLabel {
    if (t.impliedDirection === "NONE") return "UNGRADED";
    if (!t.entry.contractMark || t.entry.contractMark <= 0) return "UNGRADED";

    const returns = t.checkpoints
      .map((c) => c.contractReturnPct)
      .filter((r): r is number => r !== undefined);
    if (returns.length === 0) return "UNGRADED";

    const max = Math.max(...returns);
    const min = Math.min(...returns);
    if (max >= this.cfg.winThresholdPct) return "POSITIVE";
    if (min <= -this.cfg.lossThresholdPct) return "NEGATIVE";
    return "NEUTRAL";
  }

  private directionCorrect(t: TrackedSignal): boolean | undefined {
    if (t.impliedDirection === "NONE") return undefined;
    const d1 = t.checkpoints.find((c) => c.key === "D1");
    const move = d1?.underlyingMovePct;
    if (move === undefined) return undefined;
    return t.impliedDirection === "BULLISH" ? move > 0 : move < 0;
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export interface KindReport {
  kind: string;
  total: number;
  positive: number;
  negative: number;
  neutral: number;
  ungraded: number;
  /** positive / (positive + negative + neutral) — UNGRADED excluded, count shown. */
  hitRate: number | null;
  directionCorrectRate: number | null;
}

export function buildReport(all: TrackedSignal[]): KindReport[] {
  const byKind = new Map<string, TrackedSignal[]>();
  for (const t of all) {
    if (t.finalLabel === undefined) continue; // open signals excluded
    const arr = byKind.get(t.signal.kind) ?? [];
    arr.push(t);
    byKind.set(t.signal.kind, arr);
  }
  const out: KindReport[] = [];
  for (const [kind, items] of byKind) {
    const count = (l: OutcomeLabel) => items.filter((i) => i.finalLabel === l).length;
    const positive = count("POSITIVE");
    const negative = count("NEGATIVE");
    const neutral = count("NEUTRAL");
    const ungraded = count("UNGRADED");
    const graded = positive + negative + neutral;
    const dir = items.filter((i) => i.directionCorrectAtD1 !== undefined);
    out.push({
      kind,
      total: items.length,
      positive, negative, neutral, ungraded,
      hitRate: graded > 0 ? positive / graded : null,
      directionCorrectRate:
        dir.length > 0
          ? dir.filter((i) => i.directionCorrectAtD1 === true).length / dir.length
          : null,
    });
  }
  return out.sort((a, b) => b.total - a.total);
}
