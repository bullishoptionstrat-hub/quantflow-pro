/**
 * SMT DIVERGENCE between two correlated symbols (SPY vs QQQ, or any pair).
 *
 * Definition (versioned hypothesis, `structure-rules/1`):
 *
 *   Inputs are each symbol's bars and CONFIRMED swings, at one timeframe. For
 *   each side (HIGH, LOW) and each swing `a` of symbol A that has a previous
 *   swing `aPrev` of the same side:
 *
 *   Alignment. B's candidates are its swings of the same side whose pivot opens
 *   within ±`smtAlignToleranceBars` timeframes of `a`'s pivot. The aligned one
 *   is the nearest in time (the earlier on a tie). The answer is not knowable
 *   until B can no longer confirm a candidate: if `w` is B's last bar opening
 *   inside the window, a pivot at or before `w` is confirmed or refuted by bar
 *   w + pivotRight, so that bar's close — the RESOLVER — is when the alignment
 *   is known. Before the resolver exists, nothing is emitted.
 *
 *   Comparison. A makes a higher high when a > aPrev (lower low: a < aPrev),
 *   and B likewise for its aligned swing against B's previous swing. An equal
 *   high is NOT a higher high. When exactly one of them makes it:
 *
 *   SMT_DIVERGENCE    `leader` is the symbol that made it, `laggard` the one
 *                     that failed to. knownAt = max(a.knownAt, resolver close).
 *   (agreement)       nothing is emitted — both or neither made it.
 *
 *   SMT_UNMEASURABLE, with the reason, never a guess:
 *     - `a` has no previous swing of its side (knownAt = a.knownAt);
 *     - no swing of B lies within the tolerance of `a`;
 *     - the aligned swing of B has no previous swing;
 *     - and, anchored on B, a swing of B with no swing of A within the
 *       tolerance (so an unmatched swing is reported whichever side it is on).
 *
 *   Pairs are evaluated once, anchored on A. A swing of B that has an aligned
 *   A swing is covered by that A swing's evaluation and emits nothing itself.
 */
import { Bar, TIMEFRAME_MS } from '../market/bar';
import { DEFAULT_PARAMS, StructureParams, checkParams, methodVersionOf } from './params';
import { BarRef, EventBase, StructureInputError, cite, lastIndexOpeningAtOrBefore, refOf, requireSeries, requireVersion } from './types';
import type { SwingEvent } from './swings';
import { SwingRef, swingRef } from './structureShift';

export type SmtSide = 'HIGH' | 'LOW';

export interface SmtDivergenceEvent extends EventBase {
  kind: 'SMT_DIVERGENCE';
  side: SmtSide;
  pairSymbol: string;
  /** The symbol that made the higher high (or lower low). */
  leader: string;
  /** The symbol that failed to. */
  laggard: string;
  a: { current: SwingRef; previous: SwingRef };
  b: { current: SwingRef; previous: SwingRef };
  /** B's pivot minus A's pivot, in bars of the timeframe. */
  offsetBars: number;
}

export interface SmtUnmeasurableEvent extends EventBase {
  kind: 'SMT_UNMEASURABLE';
  side: SmtSide;
  pairSymbol: string;
  anchorSymbol: string;
  anchor: SwingRef;
  reason: string;
}

export type SmtEvent = SmtDivergenceEvent | SmtUnmeasurableEvent;

const KIND: Record<SmtSide, SwingEvent['kind']> = { HIGH: 'SWING_HIGH', LOW: 'SWING_LOW' };

export function detectSmt(
  barsA: readonly Bar[],
  barsB: readonly Bar[],
  swingsA: readonly SwingEvent[],
  swingsB: readonly SwingEvent[],
  params: StructureParams = DEFAULT_PARAMS,
): SmtEvent[] {
  requireSeries(barsA);
  requireSeries(barsB);
  checkParams(params);
  if (barsA.length === 0 || barsB.length === 0) return [];
  const symA = barsA[0].symbol, symB = barsB[0].symbol, tf = barsA[0].tf;
  if (barsB[0].tf !== tf) throw new StructureInputError([`pair timeframes differ: ${tf} and ${barsB[0].tf}`]);
  if (symA === symB) throw new StructureInputError([`a pair needs two symbols, got ${symA} twice`]);

  const methodVersion = methodVersionOf(params);
  requireVersion([...swingsA, ...swingsB], methodVersion);
  const step = TIMEFRAME_MS[tf];
  const tol = params.smtAlignToleranceBars * step;
  const R = params.pivotRight;
  const out: SmtEvent[] = [];

  const byPivot = (s: readonly SwingEvent[], side: SmtSide) =>
    s.filter((x) => x.kind === KIND[side]).sort((x, y) => x.pivot.tOpen - y.pivot.tOpen);

  /** The bar whose close settles whether `other` has a swing within tolerance of `t`, or null if not yet. */
  const resolverFor = (other: readonly Bar[], t: number): Bar | null => {
    const w = lastIndexOpeningAtOrBefore(other, t + tol);
    const k = w < 0 ? 0 : w + R;
    return k < other.length ? other[k] : null;
  };

  /** The nearest candidate within tolerance (the earlier on a tie), with its index. */
  const aligned = (cands: readonly SwingEvent[], t: number): number => {
    let best = -1;
    for (let i = 0; i < cands.length; i++) {
      const d = Math.abs(cands[i].pivot.tOpen - t);
      if (d > tol) continue;
      if (best === -1 || d < Math.abs(cands[best].pivot.tOpen - t)) best = i;
    }
    return best;
  };

  const unmeasurable = (
    side: SmtSide, anchor: SwingEvent, pairSymbol: string, knownAt: number,
    evidence: BarRef[], reason: string,
  ): SmtUnmeasurableEvent => ({
    id: `SMT_UNMEASURABLE:${side}:${anchor.id}`,
    kind: 'SMT_UNMEASURABLE',
    symbol: anchor.symbol, tf,
    knownAt, methodVersion, evidence,
    side, pairSymbol, anchorSymbol: anchor.symbol, anchor: swingRef(anchor),
    reason,
  });

  for (const side of ['HIGH', 'LOW'] as const) {
    const As = byPivot(swingsA, side);
    const Bs = byPivot(swingsB, side);
    const made = (cur: SwingEvent, prev: SwingEvent) =>
      side === 'HIGH' ? cur.price > prev.price : cur.price < prev.price;
    const word = side === 'HIGH' ? 'swing high' : 'swing low';

    As.forEach((a, k) => {
      if (k === 0) {
        out.push(unmeasurable(side, a, symB, a.knownAt, a.evidence,
          `${symA} has no previous confirmed ${word} to compare against`));
        return;
      }
      const resolver = resolverFor(barsB, a.pivot.tOpen);
      if (resolver === null) return; // B may still confirm a candidate
      const knownAt = Math.max(a.knownAt, resolver.closedAt);
      const bi = aligned(Bs, a.pivot.tOpen);
      if (bi === -1) {
        out.push(unmeasurable(side, a, symB, knownAt, cite(a.evidence, [refOf(resolver)]),
          `${symB} has no confirmed ${word} within ${params.smtAlignToleranceBars} bars of ${symA}'s pivot`));
        return;
      }
      const b = Bs[bi];
      if (bi === 0) {
        out.push(unmeasurable(side, a, symB, knownAt, cite(a.evidence, b.evidence, [refOf(resolver)]),
          `${symB}'s aligned ${word} has no previous ${word} to compare against`));
        return;
      }
      const aPrev = As[k - 1];
      const bPrev = Bs[bi - 1];
      const aMade = made(a, aPrev);
      const bMade = made(b, bPrev);
      if (aMade === bMade) return;
      out.push({
        id: `SMT_DIVERGENCE:${side}:${a.id}`,
        kind: 'SMT_DIVERGENCE',
        symbol: symA, tf,
        knownAt,
        methodVersion,
        evidence: cite(a.evidence, aPrev.evidence, b.evidence, bPrev.evidence, [refOf(resolver)]),
        side,
        pairSymbol: symB,
        leader: aMade ? symA : symB,
        laggard: aMade ? symB : symA,
        a: { current: swingRef(a), previous: swingRef(aPrev) },
        b: { current: swingRef(b), previous: swingRef(bPrev) },
        offsetBars: (b.pivot.tOpen - a.pivot.tOpen) / step,
      });
    });

    // Anchored on B: report a B swing nobody on A's side lines up with.
    for (const b of Bs) {
      const resolver = resolverFor(barsA, b.pivot.tOpen);
      if (resolver === null) continue;
      if (aligned(As, b.pivot.tOpen) !== -1) continue;
      out.push(unmeasurable(side, b, symA, Math.max(b.knownAt, resolver.closedAt),
        cite(b.evidence, [refOf(resolver)]),
        `${symA} has no confirmed ${word} within ${params.smtAlignToleranceBars} bars of ${symB}'s pivot`));
    }
  }
  return out;
}
