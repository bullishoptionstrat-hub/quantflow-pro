/**
 * Bounded reordering, and the watermark that says when an event is final.
 *
 * `RawPrint` documented its own ordering contract as "prints must arrive
 * roughly ascending". Nothing enforced it and nothing can: feeds deliver late
 * reports, retransmissions fill gaps, and receipt stamps disagree with event
 * stamps. This replaces the assumption with a stated policy.
 *
 *   incoming event (in arrival order — `availableAt` is processing time)
 *        ↓
 *   buffer, ordered by event time
 *        ↓
 *   watermark = newest event time seen − allowedLatenessMs
 *        ↓
 *   every buffered event at or before the watermark is ORDERED and final
 *
 * An event whose event time is at or before a watermark that has ALREADY been
 * released is a LATE_EVENT. It is emitted at once, flagged, and never slipped
 * into a sequence already handed downstream — inserting it would change a
 * cluster the detector has already finalised, and a backtest would then see a
 * tape no live system ever saw. What a late event does to a signal is decided
 * separately, by a frozen rule (signalRevision.ts).
 *
 * The bound is exact: an event whose delay (`availableAt − eventTime`) is
 * strictly less than `allowedLatenessMs` can never be late, because nothing
 * that arrived before it can carry an event time past its own arrival. The
 * property test holds the buffer to that.
 *
 * Sequence numbers are tracked beside the ordering, not used for it: a gap is
 * a diagnostic (events missing from the input), a fill closes it, and a repeat
 * is reported. The first sequence seen in a scope is the baseline; nothing
 * before it is claimed missing, because nothing here knows where the stream
 * began.
 */
import type { MarketEvent } from './types';

export interface ReorderOptions {
  /** How far behind the newest event time an event may arrive and still be ordered. */
  allowedLatenessMs: number;
}

/**
 * How an emission's position relative to the previous ORDERED emission was
 * established. `TIE_BROKEN_BY_ID` is the honest name for "these two share an
 * event time and nothing ordered them" — the order is deterministic and it is
 * not evidence, which is INV-EVENT-005.
 */
export type OrderBasis = 'EVENT_TIME' | 'SEQUENCE' | 'TIE_BROKEN_BY_ID' | 'FIRST';

export type Emission =
  | { kind: 'ORDERED'; event: MarketEvent; finalizedAt: number; orderBasis: OrderBasis }
  | {
      kind: 'LATE_EVENT';
      event: MarketEvent;
      finalizedAt: number;
      /** The released watermark the event arrived behind. */
      watermark: number;
      lateByMs: number;
    };

export type Diagnostic =
  | { kind: 'SEQUENCE_GAP'; scope: string; from: string; to: string; count: string; detectedAt: number }
  | { kind: 'SEQUENCE_GAP_FILLED'; scope: string; sequence: string; at: number }
  | { kind: 'SEQUENCE_REPEATED'; scope: string; sequence: string; eventId: string; at: number }
  /**
   * Below the first sequence this buffer saw in the scope. It may be a repeat
   * or a message from before the capture began; nothing here recorded that
   * range, so calling it REPEATED would be a claim about messages never seen.
   */
  | { kind: 'SEQUENCE_BEFORE_BASELINE'; scope: string; sequence: string; baseline: string; eventId: string; at: number }
  /** The input was not in arrival order. Processing time does not run backwards. */
  | { kind: 'ARRIVAL_REGRESSION'; eventId: string; availableAt: number; processingTime: number };

/** The deterministic total order the buffer releases in. */
export function canonicalOrder(a: MarketEvent, b: MarketEvent): number {
  if (a.eventTime !== b.eventTime) return a.eventTime - b.eventTime;
  const sa = a.sequenceScope ?? '';
  const sb = b.sequenceScope ?? '';
  if (sa !== sb) return sa < sb ? -1 : 1;
  const qa = a.providerSequence;
  const qb = b.providerSequence;
  if (qa !== undefined && qb !== undefined) {
    const x = BigInt(qa);
    const y = BigInt(qb);
    if (x !== y) return x < y ? -1 : 1;
  } else if (qa !== undefined || qb !== undefined) {
    return qa !== undefined ? -1 : 1;
  }
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

function basisBetween(prev: MarketEvent | null, next: MarketEvent): OrderBasis {
  if (prev === null) return 'FIRST';
  if (prev.eventTime !== next.eventTime) return 'EVENT_TIME';
  if (
    prev.sequenceScope !== undefined && prev.sequenceScope === next.sequenceScope &&
    prev.providerSequence !== undefined && next.providerSequence !== undefined &&
    prev.providerSequence !== next.providerSequence
  ) return 'SEQUENCE';
  return 'TIE_BROKEN_BY_ID';
}

/**
 * An unfilled gap, with the arrival window its missing events belong to: they
 * were disseminated after the event before the gap and before the event that
 * revealed it. That window is what lets a signal ask whether the gap could
 * have held its evidence (signalRevision.ts).
 */
export interface GapWindow {
  scope: string;
  from: string;
  to: string;
  count: string;
  openedAfterAvailableAt: number;
  revealedAtAvailableAt: number;
}

interface OpenGap {
  from: bigint;
  to: bigint;
  openedAfterAvailableAt: number;
  revealedAtAvailableAt: number;
}

interface ScopeState {
  baseline: bigint;
  highest: bigint;
  highestAvailableAt: number;
  /** Open gaps, inclusive ranges, ascending and disjoint. */
  gaps: OpenGap[];
}

export class ReorderBuffer {
  private processingTime = Number.NEGATIVE_INFINITY;
  private maxEventTime = Number.NEGATIVE_INFINITY;
  private releasedThrough = Number.NEGATIVE_INFINITY;
  private lastOrdered: MarketEvent | null = null;
  private buffer: MarketEvent[] = [];
  private readonly diags: Diagnostic[] = [];
  private readonly scopes = new Map<string, ScopeState>();
  private readonly gapHistory: Array<OpenGap & { scope: string }> = [];
  private readonly fillHistory: Array<{ scope: string; seq: bigint; at: number }> = [];

  constructor(private readonly opts: ReorderOptions) {
    if (!(Number.isFinite(opts.allowedLatenessMs) && opts.allowedLatenessMs >= 0)) {
      throw new RangeError('allowedLatenessMs must be a finite, non-negative duration');
    }
  }

  /** The watermark the buffer has released through; nothing at or before it is pending. */
  released(): number {
    return this.releasedThrough;
  }

  pending(): number {
    return this.buffer.length;
  }

  diagnostics(): Diagnostic[] {
    return [...this.diags];
  }

  /** Gaps still unfilled now. */
  openGaps(): GapWindow[] {
    return this.gapsOpenAt(Number.POSITIVE_INFINITY);
  }

  /**
   * Gaps as a reader at processing time `t` would have seen them: revealed by
   * then, minus whatever had been filled by then. An as-known revision needs
   * this, not the end state — a gap filled at 14:00:20 was still a hole at
   * 14:00:03, and a signal judged at 14:00:03 must see it as one.
   */
  gapsOpenAt(t: number): GapWindow[] {
    const out: GapWindow[] = [];
    for (const g of this.gapHistory) {
      if (g.revealedAtAvailableAt > t) continue;
      const fills = this.fillHistory
        .filter((f) => f.scope === g.scope && f.at <= t && f.seq >= g.from && f.seq <= g.to)
        .map((f) => f.seq)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      let cur = g.from;
      const piece = (from: bigint, to: bigint) => out.push({
        scope: g.scope, from: from.toString(), to: to.toString(), count: (to - from + 1n).toString(),
        openedAfterAvailableAt: g.openedAfterAvailableAt, revealedAtAvailableAt: g.revealedAtAvailableAt,
      });
      for (const f of fills) {
        if (f > cur) piece(cur, f - 1n);
        cur = f + 1n;
      }
      if (cur <= g.to) piece(cur, g.to);
    }
    return out;
  }

  push(e: MarketEvent): Emission[] {
    if (e.availableAt < this.processingTime) {
      this.diags.push({
        kind: 'ARRIVAL_REGRESSION', eventId: e.eventId,
        availableAt: e.availableAt, processingTime: this.processingTime,
      });
    }
    this.processingTime = Math.max(this.processingTime, e.availableAt);
    this.trackSequence(e);

    if (e.eventTime <= this.releasedThrough) {
      return [{
        kind: 'LATE_EVENT', event: e, finalizedAt: this.processingTime,
        watermark: this.releasedThrough, lateByMs: this.releasedThrough - e.eventTime,
      }];
    }
    this.buffer.push(e);
    this.maxEventTime = Math.max(this.maxEventTime, e.eventTime);
    return this.release(this.maxEventTime - this.opts.allowedLatenessMs);
  }

  /**
   * End of input: release everything still buffered, in order. `at` is the
   * processing time of the flush, when the caller knows it.
   */
  flush(at?: number): Emission[] {
    if (at !== undefined) this.processingTime = Math.max(this.processingTime, at);
    return this.release(Number.POSITIVE_INFINITY, this.maxEventTime);
  }

  private release(watermark: number, recordAs: number = watermark): Emission[] {
    if (watermark <= this.releasedThrough) return [];
    const ready = this.buffer.filter((e) => e.eventTime <= watermark).sort(canonicalOrder);
    this.buffer = this.buffer.filter((e) => e.eventTime > watermark);
    // The watermark advances even when nothing was ready: the slot is final,
    // and an event arriving for it afterwards is late.
    this.releasedThrough = Math.max(this.releasedThrough, recordAs);
    return ready.map((event) => {
      const orderBasis = basisBetween(this.lastOrdered, event);
      this.lastOrdered = event;
      return { kind: 'ORDERED' as const, event, finalizedAt: this.processingTime, orderBasis };
    });
  }

  private trackSequence(e: MarketEvent): void {
    if (e.providerSequence === undefined || e.sequenceScope === undefined) return;
    const seq = BigInt(e.providerSequence);
    const scope = e.sequenceScope;
    const st = this.scopes.get(scope);
    if (st === undefined) {
      this.scopes.set(scope, { baseline: seq, highest: seq, highestAvailableAt: e.availableAt, gaps: [] });
      return;
    }
    if (seq === st.highest + 1n) {
      st.highest = seq;
      st.highestAvailableAt = e.availableAt;
      return;
    }
    if (seq > st.highest + 1n) {
      const from = st.highest + 1n;
      const to = seq - 1n;
      const gap = { from, to, openedAfterAvailableAt: st.highestAvailableAt, revealedAtAvailableAt: e.availableAt };
      st.gaps.push(gap);
      this.gapHistory.push({ ...gap, scope });
      this.diags.push({
        kind: 'SEQUENCE_GAP', scope, from: from.toString(), to: to.toString(),
        count: (to - from + 1n).toString(), detectedAt: this.processingTime,
      });
      st.highest = seq;
      st.highestAvailableAt = e.availableAt;
      return;
    }
    if (seq < st.baseline) {
      this.diags.push({
        kind: 'SEQUENCE_BEFORE_BASELINE', scope, sequence: seq.toString(),
        baseline: st.baseline.toString(), eventId: e.eventId, at: this.processingTime,
      });
      return;
    }
    const i = st.gaps.findIndex((g) => seq >= g.from && seq <= g.to);
    if (i >= 0) {
      const g = st.gaps[i]!;
      const pieces: OpenGap[] = [];
      if (g.from <= seq - 1n) pieces.push({ ...g, to: seq - 1n });
      if (seq + 1n <= g.to) pieces.push({ ...g, from: seq + 1n });
      st.gaps.splice(i, 1, ...pieces);
      this.fillHistory.push({ scope, seq, at: this.processingTime });
      this.diags.push({ kind: 'SEQUENCE_GAP_FILLED', scope, sequence: seq.toString(), at: this.processingTime });
      return;
    }
    this.diags.push({
      kind: 'SEQUENCE_REPEATED', scope, sequence: seq.toString(), eventId: e.eventId, at: this.processingTime,
    });
  }
}
