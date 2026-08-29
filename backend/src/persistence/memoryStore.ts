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
    this.gaps.push(gap);
    if (this.gaps.length > MAX_GAPS) this.gaps.shift();
  }

  async listGaps(sinceMs: number): Promise<CollectionGap[]> {
    return this.gaps.filter((g) => g.endedAt >= sinceMs);
  }

  async trackRecord(): Promise<TrackRecordReport> {
    const excluded = { synthetic: 0, eventTimeOnlyBasis: 0, rightsRefused: 0 };
    // (kind, horizon) → tallies
    const buckets = new Map<string, {
      kind: string; horizon: string;
      nTotal: number; nGraded: number; nUngraded: number;
      hits: number; excursions: number[];
    }>();

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
        const b = buckets.get(key) ?? {
          kind: sig.kind, horizon,
          nTotal: 0, nGraded: 0, nUngraded: 0, hits: 0, excursions: [],
        };
        b.nTotal++;
        if (o.label === 'UNGRADED') {
          b.nUngraded++;
        } else {
          b.nGraded++;
          if (o.label === 'POSITIVE') b.hits++;
          if (typeof o.excursion === 'number') b.excursions.push(o.excursion);
        }
        buckets.set(key, b);
      }
    }

    const rows: TrackRecordRow[] = [...buckets.values()]
      .map((b) => {
        const row: TrackRecordRow = {
          kind: b.kind,
          horizon: b.horizon as TrackRecordRow['horizon'],
          nTotal: b.nTotal,
          nGraded: b.nGraded,
          nUngraded: b.nUngraded,
        };
        if (b.nGraded < MIN_PUBLISHABLE_SAMPLE) {
          row.suppressionReason = 'INSUFFICIENT_SAMPLE';
          return row;
        }
        row.hitRate = b.hits / b.nGraded;
        if (b.excursions.length > 0) row.medianExcursion = median(b.excursions);
        return row;
      })
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.horizon.localeCompare(b.horizon));

    const notes: string[] = [];
    if (rows.length === 0) {
      notes.push(
        'No real, permitted, forward-observed signal has completed a checkpoint yet. ' +
        'This is the expected state until a licensed feed is connected — it is not an error.',
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
        `${excluded.rightsRefused} signal(s) were excluded because their source is ` +
        'not affirmatively permitted for persistence under the active business mode.',
      );
    }
    if (this.evicted > 0) {
      notes.push(
        `${this.evicted} oldest signal(s) have been evicted from this in-memory store ` +
        `(cap ${MAX_SIGNALS}). Rates here describe the retained window only. Configure ` +
        'a Supabase store for a record that survives a restart.',
      );
    }

    return {
      generatedAt: new Date().toISOString(),
      rows,
      excluded,
      minSample: MIN_PUBLISHABLE_SAMPLE,
      notes,
    };
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

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? ((s[mid - 1]! + s[mid]!) / 2) : s[mid]!;
}
