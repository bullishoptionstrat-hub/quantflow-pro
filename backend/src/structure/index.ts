/**
 * THE STRUCTURE ENGINE — every detector over one symbol's closed bars, plus SMT
 * against a pair, as one time-ordered list of events.
 *
 * **There is no bar feed.** Nothing in `src/` calls this yet and no route
 * exposes it: the bar source it was written for (Phase A) is blocked, so the
 * engine is driven by tests alone. That is deliberate rather than pending
 * work — a route over an engine with no data would serve an empty list that
 * reads exactly like a quiet market.
 *
 * **Every definition is a versioned, untuned hypothesis.** The rules are written
 * at the top of each detector and mirrored in `structure*.test.ts`; the numbers
 * are in `params.ts`; `methodVersion` on every event names both. Nothing here
 * has a measured predictive value, and nothing here should be read as a signal.
 *
 * **Nothing is back-dated.** Each event's `knownAt` is the close of the bar that
 * made it knowable, and `analyse` on any prefix of a series returns exactly the
 * batch result truncated at that prefix's last close —
 * `structureLookahead.test.ts` holds that for every detector and for this
 * function, on hand fixtures and on seeded random walks.
 *
 * Pure and clock-free: `asOf` is the last close supplied, never the host's time.
 */
import { Bar, validateSeries } from '../market/bar';
import { StructureParams, methodVersionOf, paramRefusals, DEFAULT_PARAMS } from './params';
import { SwingEvent, detectSwings } from './swings';
import { LevelEvent, NOT_COMPUTED_LEVELS, detectSessionLevels } from './levels';
import { FvgEvent, detectFvgs } from './fvg';
import { DisplacementResult, detectDisplacement } from './displacement';
import { SweepEvent, detectSweeps, levelsFromSessionLevels, levelsFromSwings } from './sweep';
import { StructureShiftEvent, detectStructureShifts } from './structureShift';
import { DealingRangeEvent, detectRanges } from './range';
import { SmtEvent, detectSmt } from './smt';

export type StructureEvent =
  | SwingEvent
  | LevelEvent
  | FvgEvent
  | DisplacementResult
  | SweepEvent
  | StructureShiftEvent
  | DealingRangeEvent
  | SmtEvent;

export type StructureEventKind = StructureEvent['kind'];

/**
 * Tie-break for events known at the same close. Order of dependency: a swing
 * before what is built on it, a level before what sweeps it. It matters only
 * for determinism — events sharing a `knownAt` became knowable together.
 */
export const KIND_ORDER: readonly StructureEventKind[] = [
  'SESSION_LEVEL', 'LEVEL_UNMEASURABLE',
  'SWING_HIGH', 'SWING_LOW',
  'DEALING_RANGE', 'RANGE_UNMEASURABLE',
  'DISPLACEMENT', 'DISPLACEMENT_UNMEASURABLE',
  'FVG_FORMED', 'FVG_MITIGATED', 'FVG_FILLED', 'FVG_INVERTED', 'FVG_EXPIRED',
  'SWEEP_RECLAIM', 'ACCEPTED_BEYOND', 'WICK_NO_RECLAIM',
  'BOS', 'CHOCH', 'SHIFT_AMBIGUOUS',
  'SMT_DIVERGENCE', 'SMT_UNMEASURABLE',
];

const rank = new Map(KIND_ORDER.map((k, i) => [k, i]));

export function compareEvents(a: StructureEvent, b: StructureEvent): number {
  return a.knownAt - b.knownAt
    || (rank.get(a.kind) as number) - (rank.get(b.kind) as number)
    || a.symbol.localeCompare(b.symbol)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export interface AnalyseOptions {
  params?: Partial<StructureParams>;
  /** The other symbol of an SMT pair, at the same timeframe. */
  pair?: readonly Bar[];
}

export type AnalyseResult =
  | {
      status: 'OK';
      symbol: string;
      pairSymbol: string | null;
      tf: Bar['tf'];
      /** The last close supplied — "now" for this analysis. */
      asOf: number;
      methodVersion: string;
      params: StructureParams;
      events: StructureEvent[];
      notComputed: typeof NOT_COMPUTED_LEVELS;
    }
  | { status: 'REFUSED'; reasons: string[] };

export function analyse(bars: readonly Bar[], opts: AnalyseOptions = {}): AnalyseResult {
  const reasons: string[] = [];
  const params: StructureParams = { ...DEFAULT_PARAMS, ...(opts.params ?? {}) };
  reasons.push(...paramRefusals(params).map((r) => `params: ${r}`));

  if (bars.length === 0) reasons.push('no bars');
  const own = validateSeries(bars);
  if (!own.ok) reasons.push(...own.reasons);
  const pair = opts.pair;
  if (pair !== undefined) {
    if (pair.length === 0) reasons.push('pair: no bars');
    const v = validateSeries(pair);
    if (!v.ok) reasons.push(...v.reasons.map((r) => `pair: ${r}`));
    if (bars.length > 0 && pair.length > 0) {
      if (pair[0].tf !== bars[0].tf) reasons.push(`pair timeframe ${pair[0].tf} differs from ${bars[0].tf}`);
      if (pair[0].symbol === bars[0].symbol) reasons.push(`pair symbol ${pair[0].symbol} is the analysed symbol`);
    }
  }
  if (reasons.length > 0) return { status: 'REFUSED', reasons };

  const swings = detectSwings(bars, params);
  const levels = detectSessionLevels(bars, params);
  const events: StructureEvent[] = [
    ...swings,
    ...levels,
    ...detectRanges(swings, params),
    ...detectDisplacement(bars, params),
    ...detectFvgs(bars, params),
    ...detectSweeps(bars, [...levelsFromSessionLevels(levels), ...levelsFromSwings(swings)], params),
    ...detectStructureShifts(bars, swings, params),
  ];
  let asOf = bars[bars.length - 1].closedAt;
  if (pair !== undefined) {
    events.push(...detectSmt(bars, pair, swings, detectSwings(pair, params), params));
    asOf = Math.max(asOf, pair[pair.length - 1].closedAt);
  }
  events.sort(compareEvents);

  return {
    status: 'OK',
    symbol: bars[0].symbol,
    pairSymbol: pair !== undefined ? pair[0].symbol : null,
    tf: bars[0].tf,
    asOf,
    methodVersion: methodVersionOf(params),
    params,
    events,
    notComputed: NOT_COMPUTED_LEVELS,
  };
}

export { STRUCTURE_METHOD_VERSION, STRUCTURE_RULES_VERSION, DEFAULT_PARAMS } from './params';
