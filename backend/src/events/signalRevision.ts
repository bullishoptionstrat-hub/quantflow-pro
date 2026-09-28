/**
 * What later corrections do to a signal that already formed.
 *
 * A signal formed in real time from trades that were later cancelled still
 * HAPPENED: the live system emitted it, spoke it, and anyone watching could
 * have acted on it. So the original is never rewritten. A revision is a new
 * record beside it, derived from a tape view, and it says what the correction
 * means for each kind of research:
 *
 *   as-known studies     "what would the live system have done?" — every
 *                        signal that formed is in, whatever happened later.
 *   final-tape studies   "what did the market actually do?" — a signal built
 *                        on trades the market took back is out, or has to be
 *                        recomputed first.
 *
 * The rules are frozen here so they cannot be chosen after a result is seen:
 *
 *   1. Evidence missing from the log, disputed by a cancel that could not be
 *      resolved, or sharing a sequence scope with an UNFILLED gap whose
 *      arrival window overlaps the signal's formation → EVIDENCE_UNRESOLVED.
 *      Final-tape use waits: the missing messages could have been more
 *      evidence, or the cancel of some of it.
 *   2. Every evidence trade cancelled → INVALIDATED_BY_CORRECTION.
 *   3. Some evidence cancelled, or a LATE_EVENT trade on the same underlying
 *      inside the cluster's span ± the cluster gap → REVISED. The signal would
 *      have formed from different evidence; recompute before final-tape use.
 *   4. The view's horizon is inside the finality window → PROVISIONAL.
 *   5. Otherwise → FINAL.
 *
 * Rule 3's late-event test is deliberately a superset: a late trade that
 * WOULD have joined the cluster is caught, and so is one that would not have,
 * because deciding that means re-running the engine's clustering inside the
 * revision rule. Over-flagging costs a recomputation; under-flagging keeps a
 * signal whose evidence was incomplete, which is the flattering direction.
 */
import type { MarketEvent } from './types';
import type { TapeView } from './eventLog';
import type { GapWindow } from './reorder';
import type { SourceStatus } from './semantics';

export interface SignalEvidence {
  signalId: string;
  /** The trade events the signal was formed from. */
  evidenceEventIds: readonly string[];
  /** When it formed. Every evidence event must have been available by then. */
  decidedAt: number;
  underlying: string;
  /** The cluster's event-time span. */
  firstEventAt: number;
  lastEventAt: number;
}

export interface FinalityPolicy {
  /** How long after a decision corrections are still expected. No default: a research rule sets it. */
  finalityHorizonMs: number;
  /** The engine's clustering gap, for the late-event test. */
  clusterGapMs: number;
}

export type RevisionStatus =
  | 'PROVISIONAL'
  | 'FINAL'
  | 'REVISED'
  | 'INVALIDATED_BY_CORRECTION'
  | 'EVIDENCE_UNRESOLVED';

export interface ResearchConsequence {
  /** It formed in real time; live-behaviour studies always keep it. */
  asKnownStudies: 'INCLUDE';
  finalTapeStudies: 'INCLUDE' | 'NOT_YET_ELIGIBLE' | 'RECOMPUTE_BEFORE_USE' | 'EXCLUDE' | 'EXCLUDE_UNTIL_RESOLVED';
}

export interface SignalRevision {
  signalId: string;
  status: RevisionStatus;
  /** The view this revision was derived from: its horizon, or null for FINAL_CORRECTED. */
  evaluatedAt: number | null;
  originalEvidence: string[];
  cancelledEvidence: Array<{ eventId: string; cancelledBy: string }>;
  disputedEvidence: Array<{ eventId: string; disputedBy: string[] }>;
  missingEvidence: string[];
  /** Late trade events inside the cluster's reach. */
  lateEvidence: string[];
  /** Unfilled sequence gaps that could have held evidence or its cancel. */
  gapsInReach: GapWindow[];
  /** Evidence still ACTIVE in the view. */
  revisedEvidence: string[];
  consequence: ResearchConsequence;
  /** The view's standing — a revision is no better established than the tape it read. */
  semanticsStatus: SourceStatus;
  why: string;
}

export class LookaheadEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LookaheadEvidenceError';
  }
}

const CONSEQUENCE: Record<RevisionStatus, ResearchConsequence['finalTapeStudies']> = {
  FINAL: 'INCLUDE',
  PROVISIONAL: 'NOT_YET_ELIGIBLE',
  REVISED: 'RECOMPUTE_BEFORE_USE',
  INVALIDATED_BY_CORRECTION: 'EXCLUDE',
  EVIDENCE_UNRESOLVED: 'EXCLUDE_UNTIL_RESOLVED',
};

export interface RevisionInputs {
  /** LATE_EVENT emissions from the reorder buffer. */
  lateEvents?: readonly MarketEvent[];
  /**
   * Gaps unfilled AS OF THE VIEW'S HORIZON — `buffer.gapsOpenAt(view.asOf)`,
   * or `buffer.openGaps()` for FINAL_CORRECTED. Passing today's `openGaps()`
   * to an as-known view drops every gap filled after that view, and a signal
   * judged before the fill arrived then reads as FINAL when it was not: the
   * flattering direction. Gaps revealed after the horizon are filtered here;
   * fills cannot be, because a GapWindow does not carry them.
   */
  openGaps?: readonly GapWindow[];
}

export function reviseSignal(
  signal: SignalEvidence,
  view: TapeView,
  policy: FinalityPolicy,
  inputs: RevisionInputs = {},
): SignalRevision {
  const lateEvents = inputs.lateEvents ?? [];
  const horizon = view.asOf ?? Number.POSITIVE_INFINITY;
  if (horizon < signal.decidedAt) {
    throw new RangeError(`a view at ${horizon} predates the signal (${signal.decidedAt}); there is nothing to revise`);
  }
  const trades = new Map(view.trades.map((t) => [t.event.eventId, t]));

  const cancelled: SignalRevision['cancelledEvidence'] = [];
  const disputed: SignalRevision['disputedEvidence'] = [];
  const missing: string[] = [];
  const active: string[] = [];
  for (const id of signal.evidenceEventIds) {
    const t = trades.get(id);
    if (t === undefined) {
      missing.push(id);
      continue;
    }
    if (t.event.availableAt > signal.decidedAt) {
      // Not a market state: a signal formed from a trade it could not yet
      // have seen is a pipeline defect, and it is refused as one.
      throw new LookaheadEvidenceError(
        `evidence ${id} was available at ${t.event.availableAt}, after the signal formed at ${signal.decidedAt}`);
    }
    if (t.state === 'CANCELLED') cancelled.push({ eventId: id, cancelledBy: t.cancelledBy! });
    else if (t.state === 'CANCEL_UNRESOLVED') disputed.push({ eventId: id, disputedBy: [...t.disputedBy] });
    else active.push(id);
  }

  // Only what this view could know: a late event or a gap revealed after the
  // horizon did not exist yet for a reader at that horizon. And a signal's own
  // evidence is never "late evidence that would have joined it".
  const own = new Set(signal.evidenceEventIds);
  const late = lateEvents
    .filter((e) =>
      e.availableAt <= horizon &&
      !own.has(e.eventId) &&
      e.kind === 'TRADE_REPORT' &&
      e.instrument.underlying === signal.underlying &&
      e.eventTime >= signal.firstEventAt - policy.clusterGapMs &&
      e.eventTime <= signal.lastEventAt + policy.clusterGapMs)
    .map((e) => e.eventId);

  // A gap matters only on a stream the evidence came from, and only if its
  // missing messages were disseminated while the signal could still change.
  const scopes = new Set(signal.evidenceEventIds
    .map((id) => trades.get(id)?.event.sequenceScope)
    .filter((s): s is string => s !== undefined));
  const reachFrom = signal.firstEventAt - policy.clusterGapMs;
  const gapsInReach = (inputs.openGaps ?? []).filter((g) =>
    g.revealedAtAvailableAt <= horizon &&
    scopes.has(g.scope) &&
    g.revealedAtAvailableAt >= reachFrom &&
    g.openedAfterAvailableAt <= signal.decidedAt);

  const n = signal.evidenceEventIds.length;
  let status: RevisionStatus;
  let why: string;
  if (missing.length > 0) {
    status = 'EVIDENCE_UNRESOLVED';
    why = `${missing.length} evidence event(s) are not in the log`;
  } else if (n > 0 && cancelled.length === n) {
    status = 'INVALIDATED_BY_CORRECTION';
    why = 'every trade the signal was formed from was cancelled';
  } else if (gapsInReach.length > 0) {
    status = 'EVIDENCE_UNRESOLVED';
    why = `${gapsInReach.length} unfilled sequence gap(s) on the evidence's stream fall inside the signal's formation`;
  } else if (disputed.length > 0) {
    status = 'EVIDENCE_UNRESOLVED';
    why = `${disputed.length} evidence trade(s) may have been cancelled by a cancel that could not be resolved`;
  } else if (cancelled.length > 0 || late.length > 0) {
    status = 'REVISED';
    why = [
      cancelled.length ? `${cancelled.length} of ${n} evidence trade(s) cancelled` : '',
      late.length ? `${late.length} late trade(s) arrived inside the cluster's reach` : '',
    ].filter(Boolean).join('; ');
  } else if (horizon < signal.decidedAt + policy.finalityHorizonMs) {
    status = 'PROVISIONAL';
    why = 'the view is inside the finality window; a correction may still arrive';
  } else {
    status = 'FINAL';
    why = 'no evidence cancelled, disputed or joined late, and the finality window has passed';
  }

  return {
    signalId: signal.signalId,
    status,
    evaluatedAt: view.asOf,
    originalEvidence: [...signal.evidenceEventIds],
    cancelledEvidence: cancelled,
    disputedEvidence: disputed,
    missingEvidence: missing,
    lateEvidence: late,
    gapsInReach: [...gapsInReach],
    revisedEvidence: active,
    consequence: { asKnownStudies: 'INCLUDE', finalTapeStudies: CONSEQUENCE[status] },
    semanticsStatus: view.semanticsStatus,
    why,
  };
}

/**
 * Revisions, append-only. A signal's history only moves forward in knowledge
 * time: a revision derived from an EARLIER view than one already recorded is
 * refused, because recording it would let a stale reading displace a later
 * one. Nothing is ever replaced.
 */
export class RevisionLedger {
  private readonly bySignal = new Map<string, SignalRevision[]>();

  record(r: SignalRevision): void {
    const history = this.bySignal.get(r.signalId) ?? [];
    const last = history[history.length - 1];
    const at = (x: SignalRevision) => x.evaluatedAt ?? Number.POSITIVE_INFINITY;
    if (last !== undefined && at(r) < at(last)) {
      throw new RangeError(
        `revision for ${r.signalId} evaluated at ${at(r)} is older than the recorded one at ${at(last)}`);
    }
    history.push(structuredClone(r));
    this.bySignal.set(r.signalId, history);
  }

  history(signalId: string): SignalRevision[] {
    return (this.bySignal.get(signalId) ?? []).map((r) => structuredClone(r));
  }

  latest(signalId: string): SignalRevision | undefined {
    const h = this.bySignal.get(signalId);
    return h === undefined ? undefined : structuredClone(h[h.length - 1]!);
  }
}
