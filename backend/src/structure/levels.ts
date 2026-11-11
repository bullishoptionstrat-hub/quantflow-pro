/**
 * PRIOR-SESSION LEVELS: PDH and PDL, from the published regular session only.
 *
 * Definition (versioned hypothesis, `structure-rules/1`):
 *
 *   For every market date D that the series has bars on:
 *
 *   - If the calendar answers UNKNOWN for D (past `COVERAGE`, or not a date),
 *     the level is LEVEL_UNMEASURABLE with the calendar's own reason, known at
 *     the close of the first bar dated D. Nothing is computed from an assumed
 *     09:30–16:00 — that assumption is what kept a `MARKET OPEN` dot green
 *     through a half-day's afternoon.
 *   - If D is a WEEKEND or HOLIDAY there is no session and no level. A bar
 *     dated on one is not a regular-session bar and contributes to nothing.
 *   - If D is REGULAR or EARLY_CLOSE, its bounds come from
 *     `regularSessionInstants(D)` — 13:00 on a half day — and its RTH bars are
 *     those with `tOpen >= open` and `closedAt <= close`. PDH is the highest
 *     high among them (the earliest bar on a tie), PDL the lowest low.
 *
 *   knownAt = the close of the first bar in the series whose `closedAt` is at or
 *   after the session's close. When the last RTH bar exists, that is the close
 *   itself; when it is missing, it is the first later bar, because nothing
 *   before that bar shows the session is over.
 *
 *   status = COMPLETE when every expected bar is present
 *   (expected = (close - open) / timeframe), INCOMPLETE otherwise, with the
 *   counts published either way. A session with no RTH bars at all is
 *   LEVEL_UNMEASURABLE, not a level.
 *
 * "PDH" is the level as seen from any later session: the event names the date
 * it was measured on (`sessionDate`) and becomes usable at `knownAt`.
 *
 * PREMARKET and OVERNIGHT levels are not computed in this version, and say so
 * in `NOT_COMPUTED_LEVELS` rather than being left out silently: no
 * extended-hours bar source is known to exist, so there is nothing to measure
 * them from and nothing to check a measurement against.
 */
import { Bar, TIMEFRAME_MS } from '../market/bar';
import { marketDateOf } from '../market/civil';
import { regularSessionInstants } from '../market/session';
import { sessionOn } from '../flow-engine/calendar';
import { DEFAULT_PARAMS, StructureParams, checkParams, methodVersionOf } from './params';
import { EventBase, cite, refOf, requireSeries } from './types';

export type SessionLevelName = 'PDH' | 'PDL';

export interface SessionLevelEvent extends EventBase {
  kind: 'SESSION_LEVEL';
  name: SessionLevelName;
  price: number;
  /** The market date the level was measured on. */
  sessionDate: string;
  sessionKind: 'REGULAR' | 'EARLY_CLOSE';
  status: 'COMPLETE' | 'INCOMPLETE';
  coverage: { present: number; expected: number; openAt: number; closeAt: number };
  /**
   * Bars dated `sessionDate`, up to the bar that made the level known, that
   * fell outside its published regular hours. Later bars on the same date
   * (after a half day's 13:00 close) are not counted: they had not closed when
   * the level was published.
   */
  excludedOutsideRth: number;
}

export interface LevelUnmeasurableEvent extends EventBase {
  kind: 'LEVEL_UNMEASURABLE';
  names: SessionLevelName[];
  sessionDate: string;
  status: 'UNMEASURABLE';
  reason: string;
}

export type LevelEvent = SessionLevelEvent | LevelUnmeasurableEvent;

/** Levels this version does not compute, stated rather than omitted. */
export const NOT_COMPUTED_LEVELS = Object.freeze([
  'PREMARKET_HIGH', 'PREMARKET_LOW', 'OVERNIGHT_HIGH', 'OVERNIGHT_LOW',
].map((name) => Object.freeze({
  name,
  status: 'UNMEASURABLE' as const,
  reason:
    'No extended-hours bar source is known to exist, so this version does not ' +
    'compute extended-hours levels. Bars outside the published regular session ' +
    'are excluded from every level rather than measured.',
})));

export function detectSessionLevels(
  bars: readonly Bar[],
  params: StructureParams = DEFAULT_PARAMS,
): LevelEvent[] {
  requireSeries(bars);
  checkParams(params);
  const methodVersion = methodVersionOf(params);
  const out: LevelEvent[] = [];
  if (bars.length === 0) return out;
  const { symbol, tf } = bars[0];

  // Group by market date. Bars are time-ordered, so each date is one run.
  const runs: { date: string; from: number; to: number }[] = [];
  for (let i = 0; i < bars.length; i++) {
    const date = marketDateOf(bars[i].tOpen);
    if (date === null) continue; // unreachable for a validated bar; refuse rather than guess a date
    const last = runs[runs.length - 1];
    if (last !== undefined && last.date === date) last.to = i;
    else runs.push({ date, from: i, to: i });
  }

  const unmeasurable = (date: string, at: Bar, reason: string, evidence = [refOf(at)]): LevelUnmeasurableEvent => ({
    id: `LEVEL_UNMEASURABLE:${symbol}:${tf}:${date}`,
    kind: 'LEVEL_UNMEASURABLE',
    symbol, tf,
    knownAt: at.closedAt,
    methodVersion,
    evidence,
    names: ['PDH', 'PDL'],
    sessionDate: date,
    status: 'UNMEASURABLE',
    reason,
  });

  for (const run of runs) {
    const session = sessionOn(run.date);
    if (session.kind === 'UNKNOWN') {
      out.push(unmeasurable(run.date, bars[run.from], session.basis));
      continue;
    }
    if (session.kind === 'WEEKEND' || session.kind === 'HOLIDAY') continue;

    const bounds = regularSessionInstants(run.date);
    if (!bounds.ok) {
      out.push(unmeasurable(run.date, bars[run.from], bounds.why));
      continue;
    }

    // The bar that shows the session is over. Bars are time-ordered and do not
    // overlap, so closes increase and every RTH bar precedes or is this bar.
    let resolver = -1;
    for (let k = run.from; k < bars.length; k++) {
      if (bars[k].closedAt >= bounds.close) { resolver = k; break; }
    }
    if (resolver === -1) continue; // not knowable yet

    const rth: Bar[] = [];
    for (let k = run.from; k <= run.to; k++) {
      const b = bars[k];
      if (b.tOpen >= bounds.open && b.closedAt <= bounds.close) rth.push(b);
    }
    const resolvedBy = bars[resolver];
    if (rth.length === 0) {
      out.push(unmeasurable(
        run.date, resolvedBy,
        `no bar dated ${run.date} lies inside its published regular session`,
        cite([refOf(bars[run.from])], [refOf(resolvedBy)]),
      ));
      continue;
    }

    let hi = rth[0];
    let lo = rth[0];
    for (const b of rth) {
      if (b.h > hi.h) hi = b;
      if (b.l < lo.l) lo = b;
    }
    const expected = Math.floor((bounds.close - bounds.open) / TIMEFRAME_MS[tf]);
    const coverage = { present: rth.length, expected, openAt: bounds.open, closeAt: bounds.close };
    const shared = {
      kind: 'SESSION_LEVEL' as const,
      symbol, tf,
      knownAt: resolvedBy.closedAt,
      methodVersion,
      sessionDate: run.date,
      sessionKind: session.kind,
      status: rth.length === expected ? ('COMPLETE' as const) : ('INCOMPLETE' as const),
      coverage,
      // Only bars up to the resolver: a post-close bar that closes after
      // `knownAt` cannot be counted into a figure published at `knownAt`.
      // (The first version counted the whole date and the prefix guard caught it.)
      excludedOutsideRth: Math.min(run.to, resolver) - run.from + 1 - rth.length,
    };
    out.push({
      ...shared,
      id: `PDH:${symbol}:${tf}:${run.date}`,
      name: 'PDH',
      price: hi.h,
      evidence: cite([refOf(hi)], [refOf(resolvedBy)]),
    });
    out.push({
      ...shared,
      id: `PDL:${symbol}:${tf}:${run.date}`,
      name: 'PDL',
      price: lo.l,
      evidence: cite([refOf(lo)], [refOf(resolvedBy)]),
    });
  }
  return out;
}
