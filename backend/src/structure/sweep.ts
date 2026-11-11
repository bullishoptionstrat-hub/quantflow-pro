/**
 * SWEEPS of named levels: a wick beyond, then a close back inside.
 *
 * Definition (versioned hypothesis, `structure-rules/1`):
 *
 *   A level has a side — HIGH (a high that price may run above: a swing high,
 *   a PDH) or LOW — a price, and its own `knownAt`.
 *
 *   EXCURSION   the first bar e whose tOpen is at or after the level's knownAt
 *               and whose wick goes beyond it — HIGH: high > price;
 *               LOW: low < price. "Already known" means known when the bar
 *               OPENED: a bar during which the level became known cannot be
 *               shown to have wicked through it afterwards.
 *
 *   Then, over the bars e .. e + sweepReclaimBars - 1 (the excursion bar
 *   counts), the FIRST close that settles it decides:
 *
 *   SWEEP_RECLAIM    a close back inside — HIGH: close < price; LOW: close >
 *                    price. knownAt = the close of that bar.
 *   ACCEPTED_BEYOND  a close beyond — HIGH: close > price; LOW: close < price —
 *                    before any reclaim. Not a sweep. knownAt = that bar.
 *   WICK_NO_RECLAIM  neither within the window (every close exactly at the
 *                    level). Not a sweep either. knownAt = the window's last
 *                    bar.
 *
 *   A level is tested once. After its first resolution it is spent and emits
 *   nothing further; a level the series has not yet resolved emits nothing
 *   yet.
 */
import { Bar } from '../market/bar';
import { DEFAULT_PARAMS, StructureParams, checkParams, methodVersionOf } from './params';
import { BarRef, EventBase, cite, firstIndexOpeningAtOrAfter, refOf, requireSeries } from './types';
import type { SwingEvent } from './swings';
import type { LevelEvent } from './levels';

export type LevelSide = 'HIGH' | 'LOW';

export interface SweepLevel {
  id: string;
  /** What the level is, for a reader: 'PDH', 'SWING_LOW', ... */
  name: string;
  side: LevelSide;
  price: number;
  knownAt: number;
  evidence: BarRef[];
}

export interface SweepEvent extends EventBase {
  kind: 'SWEEP_RECLAIM' | 'ACCEPTED_BEYOND' | 'WICK_NO_RECLAIM';
  side: LevelSide;
  level: { id: string; name: string; price: number; knownAt: number };
  excursion: BarRef;
  /** The furthest price reached beyond the level, over the bars examined. */
  extreme: number;
  /** Bars after the excursion bar at which it resolved (0 = the same bar). */
  barsAfterExcursion: number;
}

/** Confirmed swings as levels: a swing high is a HIGH-side level, a low a LOW one. */
export function levelsFromSwings(swings: readonly SwingEvent[]): SweepLevel[] {
  return swings.map((s) => ({
    id: s.id,
    name: s.kind,
    side: s.kind === 'SWING_HIGH' ? 'HIGH' : 'LOW',
    price: s.price,
    knownAt: s.knownAt,
    evidence: s.evidence,
  }));
}

/**
 * Prior-session levels as sweep levels — COMPLETE ones only. An INCOMPLETE
 * session's high is the high of the bars that arrived, which may not be the
 * session's high, and a "sweep" of it would be a sweep of a number the market
 * never printed as its extreme.
 */
export function levelsFromSessionLevels(levels: readonly LevelEvent[]): SweepLevel[] {
  const out: SweepLevel[] = [];
  for (const l of levels) {
    if (l.kind !== 'SESSION_LEVEL' || l.status !== 'COMPLETE') continue;
    out.push({
      id: l.id,
      name: l.name,
      side: l.name === 'PDH' ? 'HIGH' : 'LOW',
      price: l.price,
      knownAt: l.knownAt,
      evidence: l.evidence,
    });
  }
  return out;
}

export function detectSweeps(
  bars: readonly Bar[],
  levels: readonly SweepLevel[],
  params: StructureParams = DEFAULT_PARAMS,
): SweepEvent[] {
  requireSeries(bars);
  checkParams(params);
  const methodVersion = methodVersionOf(params);
  const m = params.sweepReclaimBars;
  const out: SweepEvent[] = [];

  for (const level of levels) {
    const high = level.side === 'HIGH';
    let e = firstIndexOpeningAtOrAfter(bars, level.knownAt);
    while (e < bars.length && !(high ? bars[e].h > level.price : bars[e].l < level.price)) e++;
    if (e >= bars.length) continue;

    let kind: SweepEvent['kind'] | null = null;
    let at = -1;
    for (let k = 0; k < m; k++) {
      const j = e + k;
      if (j >= bars.length) break; // not resolvable yet
      const c = bars[j].c;
      const inside = high ? c < level.price : c > level.price;
      const beyond = high ? c > level.price : c < level.price;
      if (inside) { kind = 'SWEEP_RECLAIM'; at = j; break; }
      if (beyond) { kind = 'ACCEPTED_BEYOND'; at = j; break; }
      if (k === m - 1) { kind = 'WICK_NO_RECLAIM'; at = j; }
    }
    if (kind === null) continue;

    const window = bars.slice(e, at + 1);
    const extreme = high
      ? Math.max(...window.map((b) => b.h))
      : Math.min(...window.map((b) => b.l));
    out.push({
      id: `${kind}:${level.id}`,
      kind,
      symbol: bars[e].symbol,
      tf: bars[e].tf,
      knownAt: bars[at].closedAt,
      methodVersion,
      evidence: cite(level.evidence, window.map(refOf)),
      side: level.side,
      level: { id: level.id, name: level.name, price: level.price, knownAt: level.knownAt },
      excursion: refOf(bars[e]),
      extreme,
      barsAfterExcursion: at - e,
    });
  }
  return out;
}
