/**
 * FAIR-VALUE GAPS and their lifecycle, as separate events.
 *
 * Definition (versioned hypothesis, `structure-rules/1`):
 *
 *   Three CONTIGUOUS bars a = i-2, b = i-1, c = i — each opening exactly one
 *   timeframe after the previous. A gap across missing bars or across a
 *   session boundary is not a fair-value gap here: it is an opening gap or a
 *   hole in the feed, and calling it an FVG would assert a one-bar imbalance
 *   nobody observed.
 *
 *     BULLISH  when low(c)  > high(a): the gap is [high(a), low(c)], below price
 *     BEARISH  when high(c) < low(a):  the gap is [high(c), low(a)], above price
 *
 *   FORMED     knownAt = close of c.
 *
 *   Then, for each later bar j (counted in the series as given) until the gap
 *   is INVERTED or EXPIRED, the FIRST bar to do each of these emits it:
 *
 *     MITIGATED  traded into the gap — bullish: low(j) <= top;
 *                bearish: high(j) >= bottom. This says price reached the gap
 *                and nothing more. It is NOT graded as a successful reaction.
 *     FILLED     traded fully through it — bullish: low(j) <= bottom;
 *                bearish: high(j) >= top.
 *     INVERTED   a CLOSE beyond the far edge — bullish: close(j) < bottom;
 *                bearish: close(j) > top. A wick through is a FILL, not an
 *                inversion. Terminal.
 *     EXPIRED    `fvgExpiryBars` bars after c, if not inverted by then
 *                (including on that bar). Terminal: nothing further is emitted.
 *
 *   One bar can be all of the first three; it then emits MITIGATED, FILLED and
 *   INVERTED in that order, as three events. An inversion or an expiry is never
 *   reported as a mitigation, and a mitigation never implies the gap held.
 */
import { Bar, TIMEFRAME_MS } from '../market/bar';
import { DEFAULT_PARAMS, StructureParams, checkParams, methodVersionOf } from './params';
import { BarRef, EventBase, refOf, requireSeries } from './types';

export type FvgKind = 'FVG_FORMED' | 'FVG_MITIGATED' | 'FVG_FILLED' | 'FVG_INVERTED' | 'FVG_EXPIRED';

export interface FvgEvent extends EventBase {
  kind: FvgKind;
  fvgId: string;
  direction: 'BULLISH' | 'BEARISH';
  top: number;
  bottom: number;
  /** When the gap itself became known: the close of its third bar. */
  formedKnownAt: number;
  /** Series bars between formation and this event (0 for FORMED). */
  barsSinceFormation: number;
}

export function detectFvgs(
  bars: readonly Bar[],
  params: StructureParams = DEFAULT_PARAMS,
): FvgEvent[] {
  requireSeries(bars);
  checkParams(params);
  const methodVersion = methodVersionOf(params);
  const out: FvgEvent[] = [];
  if (bars.length < 3) return out;
  const step = TIMEFRAME_MS[bars[0].tf];

  for (let i = 2; i < bars.length; i++) {
    const a = bars[i - 2], b = bars[i - 1], c = bars[i];
    if (b.tOpen - a.tOpen !== step || c.tOpen - b.tOpen !== step) continue;

    let direction: 'BULLISH' | 'BEARISH';
    let bottom: number, top: number;
    if (c.l > a.h) { direction = 'BULLISH'; bottom = a.h; top = c.l; }
    else if (c.h < a.l) { direction = 'BEARISH'; bottom = c.h; top = a.l; }
    else continue;

    const fvgId = `FVG:${direction}:${refOf(c).id}`;
    const formation: BarRef[] = [refOf(a), refOf(b), refOf(c)];
    const emit = (kind: FvgKind, at: Bar, j: number): void => {
      out.push({
        id: kind === 'FVG_FORMED' ? fvgId : `${fvgId}/${kind}`,
        kind,
        symbol: c.symbol,
        tf: c.tf,
        knownAt: at.closedAt,
        methodVersion,
        evidence: j === i ? formation : [...formation, refOf(at)],
        fvgId, direction, top, bottom,
        formedKnownAt: c.closedAt,
        barsSinceFormation: j - i,
      });
    };
    emit('FVG_FORMED', c, i);

    let mitigated = false, filled = false, inverted = false;
    const last = Math.min(i + params.fvgExpiryBars, bars.length - 1);
    for (let j = i + 1; j <= last; j++) {
      const x = bars[j];
      const touched = direction === 'BULLISH' ? x.l <= top : x.h >= bottom;
      const through = direction === 'BULLISH' ? x.l <= bottom : x.h >= top;
      const beyond = direction === 'BULLISH' ? x.c < bottom : x.c > top;
      if (!mitigated && touched) { mitigated = true; emit('FVG_MITIGATED', x, j); }
      if (!filled && through) { filled = true; emit('FVG_FILLED', x, j); }
      if (beyond) { inverted = true; emit('FVG_INVERTED', x, j); break; }
    }
    if (!inverted && i + params.fvgExpiryBars <= bars.length - 1) {
      const j = i + params.fvgExpiryBars;
      emit('FVG_EXPIRED', bars[j], j);
    }
  }
  return out;
}
