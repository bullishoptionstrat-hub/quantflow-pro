/**
 * QuantFlow Pro — signal identity and decision time
 *
 * Two questions have to be answered before a signal can go into a permanent
 * record, and getting either wrong silently corrupts every measurement taken
 * on top of it.
 *
 *   1. WHEN was this knowable?  → `computeDecisionAt`
 *   2. WHICH signal is this?    → `signalContentHash`
 */
import { createHash } from 'crypto';
import type { ClassifiedSignal } from '../flow-engine/types';

// ─── Decision time ──────────────────────────────────────────────────────────

/**
 * How `decisionAt` was arrived at. Recorded per row, because a mixed store
 * where some rows are wall-clock-observed and others are event-time-only
 * cannot be aggregated without knowing which is which.
 */
export type DecisionBasis =
  /**
   * Every forming print carried a receipt time and the engine stamped an
   * emission time. `decisionAt` is observed, not modelled.
   */
  | 'OBSERVED'
  /**
   * Replay or a feed that supplies no receipt time. `decisionAt` falls back to
   * the last event time, which is a LOWER BOUND on when the signal was
   * knowable — it credits us with zero feed and classifier latency. Rows on
   * this basis are optimistic by an unknown margin and must not be pooled with
   * OBSERVED rows in a claim.
   */
  | 'EVENT_TIME_ONLY';

export class DecisionTimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecisionTimeError';
  }
}

export interface DecisionTime {
  /** Epoch ms. The earliest instant this signal could have been acted on. */
  decisionAt: number;
  basis: DecisionBasis;
  firstEventAt: number;
  lastEventAt: number;
  /** decisionAt − lastEventAt: the latency the record is charged. */
  latencyMs: number;
}

/**
 * The earliest instant a signal was actionable.
 *
 *   decisionAt = max(lastEventAt, receivedAt, emittedAt)
 *
 * Every term is measured; none is a constant we chose. The naive alternative
 * — the first print's timestamp — is wrong for a specific and expensive
 * reason: a signal assembled from a 500 ms burst of prints did not exist at
 * that burst's first tick. Measuring an outcome from there hands the backtest
 * 500 ms of information it did not have, and every excursion comes out
 * flattering.
 *
 * Invariant: decisionAt >= lastEventAt >= firstEventAt. An inverted timeline
 * is a bug in the feed or the clustering, and it throws rather than being
 * clamped — a clamped timestamp is indistinguishable from a correct one once
 * it is in the table.
 */
export function computeDecisionAt(sig: ClassifiedSignal): DecisionTime {
  const firstEventAt = sig.ts;
  const lastEventAt = sig.lastTs;

  if (!Number.isFinite(firstEventAt) || !Number.isFinite(lastEventAt)) {
    throw new DecisionTimeError(
      `Signal ${sig.id} has a non-finite event time (first=${firstEventAt}, last=${lastEventAt}).`,
    );
  }
  if (lastEventAt < firstEventAt) {
    throw new DecisionTimeError(
      `Signal ${sig.id} has an inverted timeline: lastTs (${lastEventAt}) is before ` +
      `ts (${firstEventAt}). Refusing to record a signal whose cluster ended before ` +
      `it began.`,
    );
  }

  const hasReceipt = typeof sig.receivedAt === 'number' && Number.isFinite(sig.receivedAt);
  const hasEmit = typeof sig.emittedAt === 'number' && Number.isFinite(sig.emittedAt);

  if (!hasReceipt || !hasEmit) {
    return {
      decisionAt: lastEventAt,
      basis: 'EVENT_TIME_ONLY',
      firstEventAt,
      lastEventAt,
      latencyMs: 0,
    };
  }

  const decisionAt = Math.max(lastEventAt, sig.receivedAt!, sig.emittedAt);
  return {
    decisionAt,
    basis: 'OBSERVED',
    firstEventAt,
    lastEventAt,
    latencyMs: decisionAt - lastEventAt,
  };
}

/**
 * Is `observationTs` strictly after the decision instant?
 *
 * Strict `>` on purpose. An observation taken at exactly the decision instant
 * is not forward of it, and admitting it is how a lookahead of one tick gets
 * in. Callers grading outcomes must use this rather than comparing directly.
 */
export function isForwardObservation(decisionAt: number, observationTs: number): boolean {
  return observationTs > decisionAt;
}

// ─── Content identity ───────────────────────────────────────────────────────

/**
 * Deterministic SHA-256 over the fields that make this signal economically
 * what it is. Deliberately EXCLUDES:
 *
 *   - `id`          — engine sequence, restarts at 1 on every process boot
 *   - `emittedAt`   — wall clock, differs on replay of identical input
 *   - `score`       — a derived opinion; rescoring must not mint a new signal
 *   - `printIds`    — arrival bookkeeping, not economics
 *
 * and deliberately INCLUDES the leg economics and both cluster boundaries, so
 * that a changed premium, size, side, strike, or expiry produces a different
 * signal rather than silently overwriting the old one.
 *
 * Canonicalisation is explicit: keys in fixed order, numbers to a fixed
 * precision, legs sorted by contract symbol. Two structurally identical
 * signals must hash identically regardless of the order their prints arrived
 * in.
 */
export function signalContentHash(sig: ClassifiedSignal): string {
  const legs = [...sig.legs]
    .map((l) => ({
      symbol: l.contract.symbol,
      underlying: l.contract.underlying,
      right: l.contract.right,
      strike: num(l.contract.strike),
      expiry: l.contract.expiry,
      side: l.side,
      totalSize: l.totalSize,
      totalPremium: num(l.totalPremium),
      vwap: num(l.vwap),
      // Venue set, sorted — a sweep that filled CBOE-then-PHLX is the same
      // sweep as one that filled PHLX-then-CBOE.
      exchanges: [...new Set(l.exchanges)].sort(),
    }))
    .sort((a, b) =>
      a.symbol === b.symbol
        ? a.side.localeCompare(b.side)
        : a.symbol.localeCompare(b.symbol),
    );

  const canonical = JSON.stringify({
    v: 1,
    kind: sig.kind,
    underlying: sig.underlying,
    side: sig.side,
    firstEventAt: sig.ts,
    lastEventAt: sig.lastTs,
    totalSize: sig.totalSize,
    totalPremium: num(sig.totalPremium),
    iso: sig.iso === true,
    legs,
  });

  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Fixed-precision rendering so floating-point noise cannot fork an identity.
 * 9 decimal places is well past any real premium or strike resolution.
 * `-0` normalises to `0`; a non-finite value is a bug and is surfaced as a
 * distinct token rather than becoming `null` and colliding with a real value.
 */
function num(n: number): string {
  if (!Number.isFinite(n)) return `NONFINITE:${String(n)}`;
  const fixed = n.toFixed(9);
  return fixed === '-0.000000000' ? '0.000000000' : fixed;
}

// ─── Write reconciliation ───────────────────────────────────────────────────

export type WriteVerdict =
  /** New content. Store it. */
  | 'INSERT'
  /** Same key, same content. A safe replay — no write needed. */
  | 'IDEMPOTENT_REPLAY'
  /**
   * Same key, DIFFERENT content. History is being rewritten. Never applied:
   * the incident is recorded and the original row stands.
   */
  | 'HISTORY_COLLISION';

export interface Reconcilable {
  signalKey: string;
  contentHash: string;
}

/**
 * Decide what to do with an incoming write.
 *
 * The third verdict is the reason this function exists. Treating every
 * duplicate key as idempotent is the default in most ingestion code, and it
 * silently accepts a rewrite of recorded history — the one thing a research
 * store must never do. A collision is a fact about the pipeline and is kept.
 */
export function reconcileWrite(
  existing: Reconcilable | undefined,
  incoming: Reconcilable,
): WriteVerdict {
  if (!existing) return 'INSERT';
  if (existing.contentHash === incoming.contentHash) return 'IDEMPOTENT_REPLAY';
  return 'HISTORY_COLLISION';
}
