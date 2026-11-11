/**
 * CONFIRMED SWING PIVOTS.
 *
 * Definition (versioned hypothesis, `structure-rules/1`):
 *
 *   A bar p is a SWING HIGH when its high is
 *     - strictly greater than the high of each of the `pivotLeft` bars before
 *       it, and
 *     - greater than or equal to the high of each of the `pivotRight` bars
 *       after it.
 *   A SWING LOW mirrors it on lows: strictly lower than each bar to the left,
 *   lower than or equal to each bar to the right.
 *
 *   Tie rule: the asymmetry (strict on the left, non-strict on the right) makes
 *   the EARLIEST of a run of equal highs the pivot and refuses the later ones,
 *   because each later one has an equal high to its left. Exactly one pivot per
 *   run of equal extremes, chosen without reference to anything after it.
 *
 *   knownAt = the close of bar p + pivotRight — the last bar the definition
 *   reads. A pivot is never emitted at its own bar: `pivotRight` is refused
 *   below 1, so the confirming bar is always a later one.
 *
 *   Bars are counted in the series as given. A time gap (missing bars,
 *   overnight) is not filled or interpolated; the N bars on either side are the
 *   N bars that exist. A bar can be both a swing high and a swing low (an
 *   outside bar with lower-high and higher-low neighbours) and then emits both.
 *
 * Bars before `pivotLeft` and within `pivotRight` of the end produce nothing:
 * the first cannot be judged, and the second cannot be judged yet.
 */
import { Bar } from '../market/bar';
import { DEFAULT_PARAMS, StructureParams, checkParams, methodVersionOf } from './params';
import { BarRef, EventBase, refOf, requireSeries } from './types';

export interface SwingEvent extends EventBase {
  kind: 'SWING_HIGH' | 'SWING_LOW';
  price: number;
  pivot: BarRef;
  confirmedBy: BarRef;
}

export function detectSwings(
  bars: readonly Bar[],
  params: StructureParams = DEFAULT_PARAMS,
): SwingEvent[] {
  requireSeries(bars);
  checkParams(params);
  const L = params.pivotLeft;
  const R = params.pivotRight;
  const methodVersion = methodVersionOf(params);
  const out: SwingEvent[] = [];

  for (let p = L; p + R < bars.length; p++) {
    const pb = bars[p];
    let high = true;
    let low = true;
    for (let j = p - L; j < p; j++) {
      if (!(bars[j].h < pb.h)) high = false;
      if (!(bars[j].l > pb.l)) low = false;
    }
    for (let j = p + 1; j <= p + R; j++) {
      if (!(bars[j].h <= pb.h)) high = false;
      if (!(bars[j].l >= pb.l)) low = false;
    }
    if (!high && !low) continue;

    const confirm = bars[p + R];
    const evidence = bars.slice(p - L, p + R + 1).map(refOf);
    const base = {
      symbol: pb.symbol,
      tf: pb.tf,
      knownAt: confirm.closedAt,
      methodVersion,
      evidence,
      pivot: refOf(pb),
      confirmedBy: refOf(confirm),
    };
    if (high) out.push({ ...base, id: `SWING_HIGH:${base.pivot.id}`, kind: 'SWING_HIGH', price: pb.h });
    if (low) out.push({ ...base, id: `SWING_LOW:${base.pivot.id}`, kind: 'SWING_LOW', price: pb.l });
  }
  return out;
}
