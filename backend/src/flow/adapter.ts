/**
 * Adapter: `flow-engine` → backend `FlowEvent` + Truth Firewall provenance.
 *
 * WHY AN ADAPTER AND NOT A REWRITE: `quantflow-modules/flow-engine` already
 * implements exactly what Wave 4 requires, correctly and with 14 passing
 * deterministic tests — in particular `NbboBook.inferSide()` returns AMBIGUOUS
 * whenever the NBBO is missing or stale, which IS the wave's exit criterion
 * ("aggressor inference never fabricates a side without NBBO"). It was simply
 * never wired into the app. Rebuilding it would duplicate working code and
 * risk losing that guarantee.
 *
 * This module's only job is translation:
 *   InferredSide  → classification grade (OBSERVED / STRONG / WEAK / UNKNOWN)
 *   SignalKind    → the backend's narrower 'SWEEP' | 'BLOCK' | 'SPLIT'
 *   ClassifiedSignal → FlowEvent + Provenance
 */

import type { ClassifiedSignal, InferredSide, SignalKind } from 'flow-engine';

import type { FlowEvent } from '../ingestion/index';
import {
  type InferenceGrade,
  type Provenance,
  syntheticProvenance,
  upstreamProvenance,
} from '../config/provenance';

/**
 * How much to trust an aggressor-side call.
 *
 * A trade at or through the NBBO is as close to OBSERVED as options tape gets
 * without exchange-supplied aggressor flags — but it is still a quote-rule
 * inference, so it is graded STRONG_INFERENCE, never OBSERVED. Nothing here
 * returns OBSERVED, because this pipeline never receives a true aggressor flag.
 */
export function gradeForSide(side: InferredSide): InferenceGrade {
  switch (side) {
    case 'BUY':
    case 'SELL':
      return 'STRONG_INFERENCE';
    case 'BUY_LEAN':
    case 'SELL_LEAN':
      return 'WEAK_INFERENCE';
    case 'AMBIGUOUS':
      return 'UNKNOWN';
  }
}

/** Numeric confidence to accompany the grade. Never 1.0 — nothing here is observed. */
export function confidenceForSide(side: InferredSide): number {
  switch (side) {
    case 'BUY':
    case 'SELL':
      return 0.8;
    case 'BUY_LEAN':
    case 'SELL_LEAN':
      return 0.55;
    case 'AMBIGUOUS':
      return 0;
  }
}

/**
 * The backend's FlowEvent type only knows SWEEP/BLOCK/SPLIT. flow-engine also
 * emits MULTI_LEG and LARGE. Mapping is explicit and lossy in a documented way
 * rather than silently defaulting.
 */
export function mapKind(kind: SignalKind): { type: FlowEvent['type']; originalKind: SignalKind } {
  switch (kind) {
    case 'SWEEP':
      return { type: 'SWEEP', originalKind: kind };
    case 'BLOCK':
    case 'LARGE':
      // LARGE is a single oversized print — a block by any reasonable reading.
      return { type: 'BLOCK', originalKind: kind };
    case 'SPLIT':
    case 'MULTI_LEG':
      // MULTI_LEG is several contracts worked together: closest to SPLIT here.
      // `originalKind` preserves the truth for consumers that care.
      return { type: 'SPLIT', originalKind: kind };
  }
}

/**
 * Sentiment from an INFERRED side, never from call/put alone.
 *
 * The old pipeline set `sentiment = call ? bullish : bearish`, which is not
 * information — buying a call and selling a call are opposite trades. When the
 * side is unknown, sentiment is 'neutral' rather than a guess.
 */
export function sentimentFor(side: InferredSide, right: 'C' | 'P'): FlowEvent['sentiment'] {
  const bucket =
    side === 'BUY' || side === 'BUY_LEAN' ? 'BUY'
    : side === 'SELL' || side === 'SELL_LEAN' ? 'SELL'
    : 'UNKNOWN';

  if (bucket === 'UNKNOWN') return 'neutral';
  if (right === 'C') return bucket === 'BUY' ? 'bullish' : 'bearish';
  return bucket === 'BUY' ? 'bearish' : 'bullish';
}

export interface AdaptOptions {
  /** Provider id this signal came from. */
  source: string;
  /** Set when the feeding data is generated/replayed. */
  synthetic?: boolean;
  /** Provider-declared delay, if any. */
  isDelayed?: true;
  estimatedDelaySeconds?: number;
  now?: () => Date;
}

/**
 * Translate one ClassifiedSignal into a FlowEvent carrying full provenance.
 *
 * The side inference always lands in provenance as `is_inferred` with its
 * method and confidence — a classifier output is never presented as observed.
 */
export function signalToFlowEvent(
  signal: ClassifiedSignal,
  opts: AdaptOptions,
): FlowEvent & { classificationGrade: InferenceGrade; inferredSide: InferredSide } {
  const leg = signal.legs[0];
  if (!leg) throw new Error(`signal ${signal.id} has no legs — refusing to fabricate one`);

  const grade = gradeForSide(signal.side);
  const confidence = confidenceForSide(signal.side);
  const { type, originalKind } = mapKind(signal.kind);
  const isSynthetic = opts.synthetic === true || signal.synthetic === true;

  const base: Provenance = isSynthetic
    ? syntheticProvenance(opts.source, opts.now)
    : upstreamProvenance(
        {
          source: opts.source,
          provider_timestamp: new Date(signal.ts).toISOString(),
          exchange_timestamp: new Date(signal.ts).toISOString(),
          ...(opts.isDelayed ? { is_delayed: true as const } : {}),
          ...(typeof opts.estimatedDelaySeconds === 'number'
            ? { estimated_delay_seconds: opts.estimatedDelaySeconds }
            : {}),
        },
        opts.now,
      );

  // The side is ALWAYS an inference on this pipeline. Record it as one.
  // AMBIGUOUS carries confidence 0, so is_inferred would be meaningless — we
  // mark it inferred anyway with method 'none_available' so a consumer can tell
  // "we tried and could not determine" apart from "we never looked".
  const provenance: Provenance = {
    ...base,
    is_inferred: true,
    inference_method:
      signal.side === 'AMBIGUOUS'
        ? 'quote_rule:no_usable_nbbo'
        : `quote_rule:${signal.side.toLowerCase()}`,
    confidence,
  };

  // Build conditions once. ISO and the original (possibly lossy-mapped) kind
  // are both preserved so nothing is silently dropped by the narrowing above.
  const conditions: string[] = [];
  if (signal.iso) conditions.push('ISO');
  if (originalKind !== type) conditions.push(originalKind);

  return {
    id: signal.id,
    timestamp: new Date(signal.ts).toISOString(),
    symbol: signal.underlying,
    expiration: leg.contract.expiry,
    strike: leg.contract.strike,
    callPut: leg.contract.right,
    type,
    size: signal.totalSize,
    premium: signal.totalPremium,
    // flow-engine's score is deterministic and explainable; reuse it directly
    // rather than recomputing a second, disagreeing number.
    heatScore: Math.round(signal.score),
    unusualScore: Math.round(signal.score),
    sentiment: sentimentFor(signal.side, leg.contract.right),
    source: opts.source,
    exchange: leg.exchanges.join(','),
    conditions,
    provenance,
    ...(isSynthetic ? { synthetic: true as const } : {}),
    classificationGrade: grade,
    inferredSide: signal.side,
  };
}
