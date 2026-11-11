/**
 * DISPLACEMENT: a bar whose body is large against the range that came BEFORE it.
 *
 * Definition (versioned hypothesis, `structure-rules/1`):
 *
 *   true range TR(j) = max(high - low, |high - close(j-1)|, |low - close(j-1)|)
 *                      for j > 0, and high - low for the first bar of the
 *                      series (which has no prior close to gap from).
 *   ATR_before(i)    = mean of TR over the `atrPeriod` bars i-n .. i-1 —
 *                      the n bars BEFORE bar i, never bar i itself. A bar that
 *                      helped set its own yardstick would be measured against
 *                      itself, and a large bar would always look a little
 *                      smaller than it is.
 *   body(i)          = |close - open|
 *
 *   DISPLACEMENT     body(i) >= displacementK * ATR_before(i), direction BULL
 *                    when close > open and BEAR when close < open. knownAt =
 *                    close of bar i.
 *   UNMEASURABLE     for every bar with fewer than n bars before it, and for a
 *                    bar whose prior n bars have zero range (the ratio is
 *                    undefined, and every bar would otherwise qualify).
 *
 *   A doji (body 0) is never a displacement. TR includes gaps between
 *   consecutive bars in the series as given — an overnight gap enlarges the
 *   next bar's TR — and that is a stated choice, not an oversight.
 */
import { Bar } from '../market/bar';
import { DEFAULT_PARAMS, StructureParams, checkParams, methodVersionOf } from './params';
import { EventBase, refOf, requireSeries } from './types';

export interface DisplacementEvent extends EventBase {
  kind: 'DISPLACEMENT';
  direction: 'BULL' | 'BEAR';
  body: number;
  atr: number;
  /** body / atr. */
  ratio: number;
}

export interface DisplacementUnmeasurableEvent extends EventBase {
  kind: 'DISPLACEMENT_UNMEASURABLE';
  reason: string;
}

export type DisplacementResult = DisplacementEvent | DisplacementUnmeasurableEvent;

export function trueRange(bars: readonly Bar[], j: number): number {
  const b = bars[j];
  if (j === 0) return b.h - b.l;
  const pc = bars[j - 1].c;
  return Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
}

/** The mean true range of the `n` bars before bar i, or null with fewer than n. */
export function atrBefore(bars: readonly Bar[], i: number, n: number): number | null {
  if (i < n) return null;
  let sum = 0;
  for (let j = i - n; j < i; j++) sum += trueRange(bars, j);
  return sum / n;
}

export function detectDisplacement(
  bars: readonly Bar[],
  params: StructureParams = DEFAULT_PARAMS,
): DisplacementResult[] {
  requireSeries(bars);
  checkParams(params);
  const methodVersion = methodVersionOf(params);
  const n = params.atrPeriod;
  const out: DisplacementResult[] = [];

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const ref = refOf(b);
    const atr = atrBefore(bars, i, n);
    const unmeasurable = (reason: string): DisplacementUnmeasurableEvent => ({
      id: `DISPLACEMENT_UNMEASURABLE:${ref.id}`,
      kind: 'DISPLACEMENT_UNMEASURABLE',
      symbol: b.symbol, tf: b.tf,
      knownAt: b.closedAt,
      methodVersion,
      evidence: [ref],
      reason,
    });
    if (atr === null) {
      out.push(unmeasurable(`needs ${n} prior bars for ATR(${n}); has ${i}`));
      continue;
    }
    if (!(atr > 0)) {
      out.push(unmeasurable(`the ${n} prior bars have zero true range; the ratio is undefined`));
      continue;
    }
    const body = Math.abs(b.c - b.o);
    if (body === 0 || body < params.displacementK * atr) continue;
    out.push({
      id: `DISPLACEMENT:${ref.id}`,
      kind: 'DISPLACEMENT',
      symbol: b.symbol, tf: b.tf,
      knownAt: b.closedAt,
      methodVersion,
      // TR(i-n) reads the close before it, so that bar is cited too.
      evidence: bars.slice(Math.max(0, i - n - 1), i + 1).map(refOf),
      direction: b.c > b.o ? 'BULL' : 'BEAR',
      body,
      atr,
      ratio: body / atr,
    });
  }
  return out;
}
