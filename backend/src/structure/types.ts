/**
 * What every structure event carries, and the one rule they all obey.
 *
 * **`knownAt` is the close of the bar that makes the event knowable**, and it
 * is never earlier than the close of any bar the event's definition needs. A
 * swing pivot is not known at the pivot; it is known when the last bar that
 * confirms it closes. A level swept is not known at the wick; it is known when
 * the close that reclaims it prints. Every event cites, in `evidence`, the bars
 * that justify it — including the bars behind any event it depends on — so the
 * rule is checkable from the event alone: `knownAt >= max(evidence.closedAt)`.
 *
 * That is the look-ahead guard in its smallest form, and
 * `structureLookahead.test.ts` holds it in its strongest: re-running on every
 * prefix of a series and keeping only what was known by that prefix's last
 * close must reproduce the batch run exactly, `knownAt` included.
 *
 * The functions here are pure and clock-free. Nothing reads the time of day:
 * "now" is the last close a caller supplied, never the host's clock.
 */
import { Bar, BarTimeframe, barId, validateSeries } from '../market/bar';

/** A citation of one bar, enough to find it again and to check `knownAt`. */
export interface BarRef {
  id: string;
  symbol: string;
  tOpen: number;
  closedAt: number;
}

export function refOf(b: Bar): BarRef {
  return { id: barId(b), symbol: b.symbol, tOpen: b.tOpen, closedAt: b.closedAt };
}

export interface EventBase {
  /** Unique within one analysis; stable across prefixes of the same series. */
  id: string;
  symbol: string;
  tf: BarTimeframe;
  /** The close of the bar that makes this event knowable. */
  knownAt: number;
  /** `methodVersionOf(params)` of the parameters that produced it. */
  methodVersion: string;
  /** The bars that justify it, including those of events it depends on. */
  evidence: BarRef[];
}

export class StructureInputError extends Error {
  constructor(public readonly reasons: string[]) {
    super(`bar series refused: ${reasons.slice(0, 5).join('; ')}${reasons.length > 5 ? ` (+${reasons.length - 5} more)` : ''}`);
  }
}

/** Detectors refuse a malformed series rather than compute over it. */
export function requireSeries(bars: readonly Bar[]): void {
  const v = validateSeries(bars);
  if (!v.ok) throw new StructureInputError(v.reasons);
}

/**
 * Events consumed by another detector must have been computed under the same
 * parameters. Swings found with a 3-bar pivot fed to a consumer that schedules
 * its own reads around a 2-bar confirmation would be a mixed method under one
 * version string — the pooling the version exists to prevent.
 */
export function requireVersion(events: readonly { id: string; methodVersion: string }[], version: string): void {
  const foreign = events.filter((e) => e.methodVersion !== version);
  if (foreign.length > 0) {
    throw new StructureInputError(foreign.slice(0, 3).map((e) =>
      `${e.id} was computed under ${e.methodVersion}, not ${version}`));
  }
}

/** Evidence without duplicates, in time order. */
export function cite(...groups: BarRef[][]): BarRef[] {
  const byId = new Map<string, BarRef>();
  for (const g of groups) for (const r of g) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => a.tOpen - b.tOpen || a.symbol.localeCompare(b.symbol));
}

/**
 * The index of the first bar whose `tOpen` is at or after `t`, or
 * `bars.length` when there is none. Bars are time-ordered, so this is a binary
 * search rather than a scan.
 */
export function firstIndexOpeningAtOrAfter(bars: readonly Bar[], t: number): number {
  let lo = 0, hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].tOpen < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** The index of the last bar whose `tOpen` is at or before `t`, or -1. */
export function lastIndexOpeningAtOrBefore(bars: readonly Bar[], t: number): number {
  let lo = 0, hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].tOpen <= t) lo = mid + 1; else hi = mid;
  }
  return lo - 1;
}
