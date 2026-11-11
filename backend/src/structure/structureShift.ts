/**
 * BREAK OF STRUCTURE and CHANGE OF CHARACTER, from closes beyond confirmed
 * swings only.
 *
 * Definition (versioned hypothesis, `structure-rules/1`):
 *
 *   References. At each bar j, the upside reference is the most recent swing
 *   high whose `knownAt` is at or before bar j's close, and the downside
 *   reference the most recent such swing low. A swing that is not yet
 *   confirmed when bar j closes does not exist as far as bar j is concerned —
 *   it cannot be broken by bar j and it does not displace an older reference.
 *   A reference once broken is spent; there is no upside reference again until
 *   a newer swing high is confirmed. An older unbroken swing is not revived.
 *
 *   A break is a CLOSE beyond the reference: close(j) > reference high, or
 *   close(j) < reference low. A wick beyond is not a break.
 *
 *   Labels. The prevailing trend starts NEUTRAL.
 *     - An upside break while the trend is BEAR is a CHOCH; otherwise a BOS.
 *     - A downside break while the trend is BULL is a CHOCH; otherwise a BOS.
 *     - The trend becomes BULL after any upside break, BEAR after any downside.
 *   So the FIRST break of a series is labelled BOS with `priorTrend: NEUTRAL`:
 *   a change of character needs a character to change, and NEUTRAL has none.
 *
 *   A single close beyond BOTH references (possible when the reference high is
 *   below the reference low) is SHIFT_AMBIGUOUS: both references are spent and
 *   the trend is unchanged, because the bar says two contradictory things.
 *
 *   knownAt = the close of the breaking bar. Evidence cites that bar and every
 *   bar behind the broken swing.
 */
import { Bar } from '../market/bar';
import { DEFAULT_PARAMS, StructureParams, checkParams, methodVersionOf } from './params';
import { EventBase, cite, refOf, requireSeries, requireVersion } from './types';
import type { SwingEvent } from './swings';

export type Trend = 'NEUTRAL' | 'BULL' | 'BEAR';

export interface SwingRef {
  id: string;
  kind: SwingEvent['kind'];
  price: number;
  pivotTOpen: number;
  knownAt: number;
}

export const swingRef = (s: SwingEvent): SwingRef => ({
  id: s.id, kind: s.kind, price: s.price, pivotTOpen: s.pivot.tOpen, knownAt: s.knownAt,
});

export interface ShiftEvent extends EventBase {
  kind: 'BOS' | 'CHOCH';
  direction: 'UP' | 'DOWN';
  priorTrend: Trend;
  trendAfter: Trend;
  broken: SwingRef;
  close: number;
}

export interface ShiftAmbiguousEvent extends EventBase {
  kind: 'SHIFT_AMBIGUOUS';
  reason: string;
  high: SwingRef;
  low: SwingRef;
  close: number;
}

export type StructureShiftEvent = ShiftEvent | ShiftAmbiguousEvent;

export function detectStructureShifts(
  bars: readonly Bar[],
  swings: readonly SwingEvent[],
  params: StructureParams = DEFAULT_PARAMS,
): StructureShiftEvent[] {
  requireSeries(bars);
  checkParams(params);
  const methodVersion = methodVersionOf(params);
  requireVersion(swings, methodVersion);
  const byConfirmation = (a: SwingEvent, b: SwingEvent) => a.knownAt - b.knownAt || a.pivot.tOpen - b.pivot.tOpen;
  const highs = swings.filter((s) => s.kind === 'SWING_HIGH').sort(byConfirmation);
  const lows = swings.filter((s) => s.kind === 'SWING_LOW').sort(byConfirmation);

  const out: StructureShiftEvent[] = [];
  let trend: Trend = 'NEUTRAL';
  let hi = 0, lo = 0;
  let refHigh: SwingEvent | null = null;
  let refLow: SwingEvent | null = null;
  let highSpent = false, lowSpent = false;

  for (const bar of bars) {
    while (hi < highs.length && highs[hi].knownAt <= bar.closedAt) { refHigh = highs[hi++]; highSpent = false; }
    while (lo < lows.length && lows[lo].knownAt <= bar.closedAt) { refLow = lows[lo++]; lowSpent = false; }

    const up = refHigh !== null && !highSpent && bar.c > refHigh.price;
    const down = refLow !== null && !lowSpent && bar.c < refLow.price;
    if (!up && !down) continue;

    const at = refOf(bar);
    if (up && down && refHigh !== null && refLow !== null) {
      highSpent = true;
      lowSpent = true;
      out.push({
        id: `SHIFT_AMBIGUOUS:${at.id}`,
        kind: 'SHIFT_AMBIGUOUS',
        symbol: bar.symbol, tf: bar.tf,
        knownAt: bar.closedAt,
        methodVersion,
        evidence: cite([at], refHigh.evidence, refLow.evidence),
        reason: `close ${bar.c} is above the reference high ${refHigh.price} and below the reference low ${refLow.price}`,
        high: swingRef(refHigh),
        low: swingRef(refLow),
        close: bar.c,
      });
      continue;
    }

    const broken = up ? refHigh : refLow;
    if (broken === null) continue; // unreachable: `up`/`down` require their reference
    const direction = up ? 'UP' : 'DOWN';
    const reversal = up ? trend === 'BEAR' : trend === 'BULL';
    const kind = reversal ? 'CHOCH' : 'BOS';
    const priorTrend = trend;
    trend = up ? 'BULL' : 'BEAR';
    if (up) highSpent = true; else lowSpent = true;
    out.push({
      id: `${kind}:${direction}:${at.id}`,
      kind,
      symbol: bar.symbol, tf: bar.tf,
      knownAt: bar.closedAt,
      methodVersion,
      evidence: cite([at], broken.evidence),
      direction,
      priorTrend,
      trendAfter: trend,
      broken: swingRef(broken),
      close: bar.c,
    });
  }
  return out;
}
