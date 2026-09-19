/**
 * QuantFlow Pro — in-memory signal store
 *
 * The reference implementation of `SignalStore`. It holds the policy the
 * Supabase adapter mirrors, and it is what the tests run against, so the
 * rules below are provable without a database:
 *
 *   - a differing write on an existing key is a HISTORY_COLLISION, recorded
 *     and refused; the original row stands
 *   - outcomes are append-only; a correction supersedes by revision
 *   - synthetic signals never reach the track record's rows
 *   - a hit rate under MIN_PUBLISHABLE_SAMPLE is suppressed, not rounded
 *
 * Memory is bounded. This is a research record, but the process it runs in is
 * a web server on a free tier that gets restarted constantly — so the store
 * caps itself and reports the eviction rather than growing until the process
 * is killed, which would lose everything instead of the oldest thing.
 */
import {
  reconcileWrite,
  type WriteVerdict,
} from './identity';
import {
  emptyTally, tallyOutcome, tallyToRows, reportNotes, type OutcomeTally,
} from './trackRecordRows';
import {
  assembleBacktest, matchesScanner,
  type BacktestReport, type MatchedSignal, type ScannerFilter,
} from './backtest';
import {
  MIN_PUBLISHABLE_SAMPLE,
  type CollectionGap,
  type OutcomeRecord,
  type SignalRecord,
  type SignalStore,
  type TrackRecordReport,
  type TrackRecordRow,
  type WriteIncident,
  type WriteResult,
} from './types';

/** Beyond this many signals the oldest are evicted, oldest-decision-first. */
const MAX_SIGNALS = 50_000;
const MAX_INCIDENTS = 1_000;
const MAX_GAPS = 5_000;

export class InMemorySignalStore implements SignalStore {
  readonly kind = 'memory' as const;

  private readonly signals = new Map<string, SignalRecord>();
  /** signalKey → horizon → the LIVE revision for that horizon. */
  private readonly outcomes = new Map<string, Map<string, OutcomeRecord>>();
  /** Every revision ever written, including superseded ones. */
  private readonly outcomeHistory = new Map<string, OutcomeRecord[]>();
  private readonly incidents: WriteIncident[] = [];
  private readonly gaps: CollectionGap[] = [];
  private evicted = 0;

  async writeSignal(rec: SignalRecord): Promise<WriteResult> {
    const existing = this.signals.get(rec.signalKey);
    const verdict: WriteVerdict = reconcileWrite(existing, rec);

    if (verdict === 'HISTORY_COLLISION') {
      await this.recordIncident({
        signalKey: rec.signalKey,
        incidentType: 'HISTORY_COLLISION',
        existingContentHash: existing!.contentHash,
        incomingContentHash: rec.contentHash,
        detectedAt: Date.now(),
        note:
          `Same signal key arrived with different content. The stored row was kept ` +
          `and the incoming write refused. Two different signals hashing to one key, ` +
          `or one signal whose economics changed after emission — either is a ` +
          `pipeline defect worth finding.`,
      });
      return { verdict, signalKey: rec.signalKey };
    }

    if (verdict === 'INSERT') {
      this.signals.set(rec.signalKey, rec);
      this.evictIfNeeded();
    }
    return { verdict, signalKey: rec.signalKey };
  }

  async getSignal(signalKey: string): Promise<SignalRecord | undefined> {
    return this.signals.get(signalKey);
  }

  async listUngraded(limit: number): Promise<SignalRecord[]> {
    const out: SignalRecord[] = [];
    for (const s of this.signals.values()) {
      if (s.synthetic) continue;
      const graded = this.outcomes.get(s.signalKey);
      // "Ungraded" means no LIVE outcome exists for at least one horizon.
      if (!graded || graded.size < 4) out.push(s);
      if (out.length >= limit) break;
    }
    return out;
  }

  async countSignals() {
    let synthetic = 0;
    for (const s of this.signals.values()) if (s.synthetic) synthetic++;
    return {
      total: this.signals.size,
      synthetic,
      real: this.signals.size - synthetic,
    };
  }

  async writeOutcome(rec: OutcomeRecord): Promise<void> {
    if (rec.label === 'UNGRADED' && !rec.ungradedReason?.trim()) {
      throw new Error(
        `Outcome for ${rec.signalKey}/${rec.horizon} is UNGRADED with no reason. ` +
        `An ungraded outcome without a stated reason cannot be distinguished from ` +
        `a grading bug, so it is refused.`,
      );
    }

    const perSignal = this.outcomes.get(rec.signalKey) ?? new Map<string, OutcomeRecord>();
    const live = perSignal.get(rec.horizon);

    if (live && rec.supersedes !== live.signalKey + ':' + live.revision) {
      // An in-place edit of a graded outcome. Refused: supersession is the
      // only correction path, and it must name what it replaces.
      throw new Error(
        `Outcome ${rec.signalKey}/${rec.horizon} is already graded at revision ` +
        `${live.revision} and is immutable. To correct it, write a new outcome with ` +
        `supersedes="${live.signalKey}:${live.revision}" and revision ${live.revision + 1}.`,
      );
    }

    perSignal.set(rec.horizon, rec);
    this.outcomes.set(rec.signalKey, perSignal);

    const hist = this.outcomeHistory.get(rec.signalKey) ?? [];
    hist.push(rec);
    this.outcomeHistory.set(rec.signalKey, hist);
  }

  async listOutcomes(signalKey: string): Promise<OutcomeRecord[]> {
    return [...(this.outcomeHistory.get(signalKey) ?? [])];
  }

  async recordIncident(inc: WriteIncident): Promise<void> {
    this.incidents.push(inc);
    if (this.incidents.length > MAX_INCIDENTS) this.incidents.shift();
  }

  async listIncidents(limit: number): Promise<WriteIncident[]> {
    return this.incidents.slice(-limit).reverse();
  }

  async recordGap(gap: CollectionGap): Promise<void> {
    if (gap.endedAt < gap.startedAt) {
      throw new Error(
        `Gap ${gap.id} ends (${gap.endedAt}) before it starts (${gap.startedAt}).`,
      );
    }
    if (gap.reason.trim().length < 10) {
      throw new Error(
        `Gap ${gap.id} has reason "${gap.reason}", which is too thin to be useful. ` +
        `A gap's reason is read months later by someone deciding whether a window ` +
        `is usable — state what actually happened.`,
      );
    }
    // Upsert on `id`, matching `supabaseStore.recordGap`, which does an
    // `upsert`. This pushed, so the two stores disagreed about the same call:
    // an open gap re-recorded each tick as it was extended became one row in
    // Postgres and one row per tick in memory — so the in-memory coverage
    // summary would have counted the same window dozens of times, and the
    // tests that drive the in-memory store would not have caught the
    // difference. A store seam that behaves differently under test than in
    // production is worse than no seam.
    const existing = this.gaps.findIndex((g) => g.id === gap.id);
    if (existing >= 0) this.gaps[existing] = gap;
    else this.gaps.push(gap);
    if (this.gaps.length > MAX_GAPS) this.gaps.shift();
  }

  async listGaps(sinceMs: number): Promise<CollectionGap[]> {
    return this.gaps.filter((g) => g.endedAt >= sinceMs);
  }

  async trackRecord(): Promise<TrackRecordReport> {
    const excluded = { synthetic: 0, eventTimeOnlyBasis: 0, rightsRefused: 0 };
    const tallies = new Map<string, OutcomeTally>();

    for (const sig of this.signals.values()) {
      // Three exclusions, each counted so the reader sees the shape of what
      // was left out rather than just a smaller number.
      if (sig.synthetic) { excluded.synthetic++; continue; }
      if (sig.decisionBasis === 'EVENT_TIME_ONLY') { excluded.eventTimeOnlyBasis++; continue; }
      if (sig.rightsClass !== 'PERMITTED') { excluded.rightsRefused++; continue; }

      const live = this.outcomes.get(sig.signalKey);
      if (!live) continue;

      for (const [horizon, o] of live) {
        const key = `${sig.kind}|${horizon}`;
        const t = tallies.get(key) ?? emptyTally(sig.kind, horizon);
        tallyOutcome(t, o);
        tallies.set(key, t);
      }
    }

    // Rows and prose come from `trackRecordRows.ts`, shared with the Supabase
    // store. Gathering differs between the two — maps here, paged PostgREST
    // there — and everything after gathering had already drifted: the note
    // warning that the M15/H1/D1 rows for one kind share a single sample
    // existed only in the other copy, and this is the store that actually
    // answers the endpoint.
    const rows = tallyToRows(tallies.values());

    // The one note only this store can make. Eviction is a property of the
    // in-memory cap, not of the record, so it cannot live in the shared list —
    // and the first version of this refactor dropped it entirely, which would
    // have let a retained-window rate present itself as the whole history.
    return {
      generatedAt: new Date().toISOString(),
      rows,
      excluded,
      minSample: MIN_PUBLISHABLE_SAMPLE,
      notes: reportNotes(rows, excluded, this.evictionNotes()),
    };
  }

  /**
   * A scanner backtest over the retained population.
   *
   * Gathering (walk the maps, join outcomes to signals) is this store's
   * business; everything after — exclusions, tally, rows, prose — is
   * `assembleBacktest`, which is the same shared machinery `trackRecord` uses.
   * A backtest grades nothing: it reads back outcomes the grader already wrote.
   *
   * The eviction note travels through the same store-specific channel it does
   * for the track record — a rate over a retained window is a retained-window
   * rate whether or not a filter narrowed it.
   */
  async backtest(filter: ScannerFilter): Promise<BacktestReport> {
    const matched: MatchedSignal[] = [];
    for (const sig of this.signals.values()) {
      if (!matchesScanner(sig, filter)) continue;
      const live = this.outcomes.get(sig.signalKey);
      matched.push({
        signal: sig,
        outcomes: live ? [...live.values()] : [],
      });
    }
    return assembleBacktest(filter, matched, this.evictionNotes());
  }

  /**
   * The store-specific notes for this deployment's cap, shared by both the
   * track record and any backtest. Empty when nothing has been evicted.
   */
  private evictionNotes(): string[] {
    if (this.evicted === 0) return [];
    return [
      `${this.evicted} oldest signal(s) have been evicted from this in-memory store ` +
      `(cap ${MAX_SIGNALS}). Rates here describe the retained window only. Configure ` +
      'a Supabase store for a record that survives a restart.',
    ];
  }

  private evictIfNeeded(): void {
    if (this.signals.size <= MAX_SIGNALS) return;
    const ordered = [...this.signals.values()].sort((a, b) => a.decisionAt - b.decisionAt);
    const dropCount = this.signals.size - MAX_SIGNALS;
    for (let i = 0; i < dropCount; i++) {
      const victim = ordered[i];
      if (!victim) break;
      this.signals.delete(victim.signalKey);
      this.outcomes.delete(victim.signalKey);
      this.outcomeHistory.delete(victim.signalKey);
      this.evicted++;
    }
  }
}

