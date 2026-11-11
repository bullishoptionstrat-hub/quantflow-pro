/**
 * THE DEALING RANGE: between the most recent confirmed swing high and swing low.
 *
 * Definition (versioned hypothesis, `structure-rules/1`):
 *
 *   Whenever a swing is confirmed and both a confirmed swing high and a
 *   confirmed swing low exist, the dealing range is the most recent of each
 *   (by confirmation).
 *
 *     EQ        = (high + low) / 2
 *     PREMIUM   = [EQ, high]   — the upper half
 *     DISCOUNT  = [low, EQ]    — the lower half
 *
 *   knownAt = the later of the two swings' `knownAt` — the moment both ends
 *   exist. One event per confirmation that changes either end.
 *
 *   RANGE_UNMEASURABLE when the most recent swing high is not above the most
 *   recent swing low. That happens (a fast move confirms a low above an older
 *   high) and there is no range between them to halve; a "range" with its top
 *   below its bottom would put every price in premium and discount at once.
 *
 * `zoneOf` places a price against a range. It is a helper, not an event: where
 * a price sits is a fact about the price, asked by the caller at its own time.
 */
import { DEFAULT_PARAMS, StructureParams, checkParams, methodVersionOf } from './params';
import { EventBase, cite, requireVersion } from './types';
import type { SwingEvent } from './swings';
import { SwingRef, swingRef } from './structureShift';

export interface RangeEvent extends EventBase {
  kind: 'DEALING_RANGE';
  high: SwingRef;
  low: SwingRef;
  eq: number;
  premium: { from: number; to: number };
  discount: { from: number; to: number };
}

export interface RangeUnmeasurableEvent extends EventBase {
  kind: 'RANGE_UNMEASURABLE';
  reason: string;
  high: SwingRef;
  low: SwingRef;
}

export type DealingRangeEvent = RangeEvent | RangeUnmeasurableEvent;

export function detectRanges(
  swings: readonly SwingEvent[],
  params: StructureParams = DEFAULT_PARAMS,
): DealingRangeEvent[] {
  checkParams(params);
  const methodVersion = methodVersionOf(params);
  requireVersion(swings, methodVersion);
  const ordered = [...swings].sort((a, b) =>
    a.knownAt - b.knownAt || a.pivot.tOpen - b.pivot.tOpen || a.kind.localeCompare(b.kind));
  const out: DealingRangeEvent[] = [];
  let high: SwingEvent | null = null;
  let low: SwingEvent | null = null;

  for (let i = 0; i < ordered.length; ) {
    // Every swing confirmed at the same close lands together: one range, not two.
    const at = ordered[i].knownAt;
    for (; i < ordered.length && ordered[i].knownAt === at; i++) {
      const s = ordered[i];
      if (s.kind === 'SWING_HIGH') high = s; else low = s;
    }
    if (high === null || low === null) continue;

    const base = {
      symbol: high.symbol,
      tf: high.tf,
      knownAt: Math.max(high.knownAt, low.knownAt),
      methodVersion,
      evidence: cite(high.evidence, low.evidence),
      high: swingRef(high),
      low: swingRef(low),
    };
    const id = `${high.id}|${low.id}`;
    if (!(high.price > low.price)) {
      out.push({
        ...base,
        id: `RANGE_UNMEASURABLE:${id}`,
        kind: 'RANGE_UNMEASURABLE',
        reason: `the most recent swing high ${high.price} is not above the most recent swing low ${low.price}`,
      });
      continue;
    }
    const eq = (high.price + low.price) / 2;
    out.push({
      ...base,
      id: `DEALING_RANGE:${id}`,
      kind: 'DEALING_RANGE',
      eq,
      premium: { from: eq, to: high.price },
      discount: { from: low.price, to: eq },
    });
  }
  return out;
}

export type RangeZone = 'ABOVE_RANGE' | 'PREMIUM' | 'EQUILIBRIUM' | 'DISCOUNT' | 'BELOW_RANGE';

/** Where a price sits in a range. Exactly at EQ is EQUILIBRIUM, not either half. */
export function zoneOf(price: number, range: Pick<RangeEvent, 'high' | 'low' | 'eq'>): RangeZone {
  if (price > range.high.price) return 'ABOVE_RANGE';
  if (price < range.low.price) return 'BELOW_RANGE';
  if (price > range.eq) return 'PREMIUM';
  if (price < range.eq) return 'DISCOUNT';
  return 'EQUILIBRIUM';
}
