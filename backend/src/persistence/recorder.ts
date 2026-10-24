/**
 * QuantFlow Pro — signal recorder
 *
 * The one path from a classified signal to the durable record. It answers, in
 * order: may we keep this, when was it knowable, which signal is it, and then
 * writes.
 *
 * Every refusal is counted rather than logged and forgotten, because "we
 * persisted 400 signals today" is meaningless without "and refused 9,000 from
 * a source we have no rights to".
 */
import type { ClassifiedSignal } from '../flow-engine/types';
import {
  classifySource,
  resolveBusinessMode,
  type BusinessMode,
} from '../provenance/rights';
import { computeDecisionAt, signalContentHash } from './identity';
import type { SignalRecord, SignalStore, StoredLeg } from './types';

export interface RecordOutcome {
  status: 'RECORDED' | 'REPLAY' | 'COLLISION' | 'REFUSED_RIGHTS' | 'HELD_UNVALIDATED' | 'ERROR';
  signalKey?: string;
  reason?: string;
}

export interface RecorderStats {
  seen: number;
  recorded: number;
  replays: number;
  collisions: number;
  refusedRights: number;
  errors: number;
  syntheticRecorded: number;
  /** datasetId → count of refusals, so the operator sees *which* source. */
  refusalsByDataset: Record<string, number>;
  /**
   * Signals not recorded because a contributing source is permitted but has
   * not yet shown, on its own prints, that it delivers working market data.
   * Counted per source. Distinct from a rights refusal: the remedy is to wait
   * for (or fix) the feed, not to read a publisher's terms.
   */
  heldUnvalidated: number;
  heldBySource: Record<string, number>;
  lastError?: string;
}

const NONE_HELD: ReadonlySet<string> = new Set();

export class SignalRecorder {
  private stats: RecorderStats = {
    seen: 0, recorded: 0, replays: 0, collisions: 0,
    refusedRights: 0, errors: 0, syntheticRecorded: 0,
    refusalsByDataset: {}, heldUnvalidated: 0, heldBySource: {},
  };

  /** Sources whose prints are not yet admitted. Empty unless a validator says otherwise. */
  private held: () => ReadonlySet<string> = () => NONE_HELD;

  constructor(
    private readonly store: SignalStore,
    private readonly mode: BusinessMode = resolveBusinessMode(),
  ) {}

  getStats(): RecorderStats {
    return {
      ...this.stats,
      refusalsByDataset: { ...this.stats.refusalsByDataset },
      heldBySource: { ...this.stats.heldBySource },
    };
  }

  /**
   * Hold back signals from sources a live validator has not yet passed.
   *
   * The record is append-only: a signal written from a feed whose mapping is
   * broken — a print with no quote, a price from the wrong contract, a
   * timestamp in the wrong unit — cannot be taken back out, and would be
   * graded and published like any other. So a source the ingestion layer is
   * still validating is held: displayed live, not persisted. Holding loses
   * those signals from the record, deliberately, and the coverage ledger
   * marks the window as not collected rather than as a quiet tape.
   */
  holdUntilValidated(held: () => ReadonlySet<string>): void {
    this.held = held;
  }

  /**
   * Persist one signal.
   *
   * `source` is the connector label carried by the forming prints; `synthetic`
   * is the engine's own flag, which is true when ANY forming print was
   * simulated. Synthetic signals ARE stored — they are our own data and raise
   * no rights question — but they are marked, and the track record excludes
   * them by construction. Storing them is what makes "this deployment has
   * produced zero real signals" a visible fact rather than an empty table
   * indistinguishable from a broken writer.
   */
  async record(
    sig: ClassifiedSignal,
    origin: { source: string; sources: string[]; synthetic: boolean },
  ): Promise<RecordOutcome> {
    this.stats.seen++;
    const { source, sources, synthetic } = origin;

    // EVERY contributing source must be permitted. Checking only the first
    // print's source would let one permitted print carry a whole cluster of
    // unverified ones into the record — and clusters do span sources, because
    // the engine groups by underlying and time, not by feed.
    const decisions = sources.map((s) => classifySource(s, 'PERSIST', this.mode));
    const refused = decisions.find((d) => !d.allowed);
    if (refused) {
      this.stats.refusedRights++;
      const k = refused.datasetId;
      this.stats.refusalsByDataset[k] = (this.stats.refusalsByDataset[k] ?? 0) + 1;
      return {
        status: 'REFUSED_RIGHTS',
        reason: sources.length > 1
          ? `Signal formed from sources [${sources.join(', ')}]; ${refused.reason}`
          : refused.reason,
      };
    }
    const held = this.held();
    const unvalidated = sources.filter((s) => held.has(s));
    if (unvalidated.length > 0) {
      this.stats.heldUnvalidated++;
      for (const s of unvalidated) this.stats.heldBySource[s] = (this.stats.heldBySource[s] ?? 0) + 1;
      return {
        status: 'HELD_UNVALIDATED',
        reason: `Not recorded: ${unvalidated.join(', ')} has not yet passed live validation, so its prints `
          + 'are displayed but kept out of the append-only record.',
      };
    }
    const decision = decisions[0]!;

    try {
      const t = computeDecisionAt(sig);
      const contentHash = signalContentHash(sig);

      const rec: SignalRecord = {
        signalKey: contentHash,
        contentHash,
        engineId: sig.id,
        kind: sig.kind,
        underlying: sig.underlying,
        side: sig.side,
        totalPremium: sig.totalPremium,
        totalSize: sig.totalSize,
        iso: sig.iso,
        score: sig.score,
        scoreBreakdown: sig.scoreBreakdown,
        legs: sig.legs.map(toStoredLeg),
        spreadGuess: sig.spreadGuess,
        firstEventAt: t.firstEventAt,
        lastEventAt: t.lastEventAt,
        decisionAt: t.decisionAt,
        decisionBasis: t.basis,
        latencyMs: t.latencyMs,
        source,
        datasetId: decision.datasetId,
        rightsClass: decision.rightsClass,
        synthetic,
        recordedAt: Date.now(),
      };

      const res = await this.store.writeSignal(rec);
      if (res.verdict === 'INSERT') {
        this.stats.recorded++;
        if (synthetic) this.stats.syntheticRecorded++;
        return { status: 'RECORDED', signalKey: res.signalKey };
      }
      if (res.verdict === 'IDEMPOTENT_REPLAY') {
        this.stats.replays++;
        return { status: 'REPLAY', signalKey: res.signalKey };
      }
      this.stats.collisions++;
      return {
        status: 'COLLISION',
        signalKey: res.signalKey,
        reason: 'Same key, different content — the stored row was kept.',
      };
    } catch (err) {
      this.stats.errors++;
      const msg = err instanceof Error ? err.message : String(err);
      this.stats.lastError = msg;
      // Persistence must never take the live feed down with it. The signal
      // still reaches the UI; only the record of it is lost, and the loss is
      // counted here rather than swallowed.
      return { status: 'ERROR', reason: msg };
    }
  }
}

function toStoredLeg(l: ClassifiedSignal['legs'][number]): StoredLeg {
  return {
    contractSymbol: l.contract.symbol,
    underlying: l.contract.underlying,
    right: l.contract.right,
    strike: l.contract.strike,
    expiry: l.contract.expiry,
    side: l.side,
    totalSize: l.totalSize,
    totalPremium: l.totalPremium,
    vwap: l.vwap,
    prints: l.prints,
    exchanges: l.exchanges,
  };
}
