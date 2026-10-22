/**
 * H-001-v2 §K's exploratory endpoints, H1 and D1, as code.
 *
 * §K: "M15 is the only primary endpoint. H1 and D1 are exploratory, reported
 * without multiplicity correction, and support no claim." The frozen text
 * says what they are for and nothing about how to measure them, so every rule
 * below is a reading, written before any data exists and open to challenge
 * until it does:
 *
 *   K1  H1 and D1 are the repository's own nominal horizons — 60 minutes and
 *       24 hours, `HORIZON_NOMINAL_MS`, the table the grader schedules from —
 *       so the study and the track record mean the same thing by "H1" and
 *       "D1". Entry is §C's, unchanged; the exit is t_entry + the horizon,
 *       read by §C's exit rule (the latest quote stamped by then, final tape).
 *   K2  A unit whose exit does not fall inside a regular session — after its
 *       date's published close, before its open, on a weekend or holiday — is
 *       not measured at that horizon, and is counted. Past the calendar's
 *       coverage the calendar cannot say, and that is counted apart
 *       (`SESSION_UNKNOWN`), never as a closure: "cannot say" read as "not
 *       open" is how an outage gets filed as a holiday. The latest quote before a Saturday exit is Friday's, and a
 *       15:30 decision's H1 exit is after the close: measuring either reports a
 *       different quantity under the same label, and which one would depend
 *       on whether the vendor's file carries extended-hours quotes — the
 *       argument that made the balance window's V3 a rule. So D1 is measured
 *       for decisions whose next calendar day is a session, and H1 for
 *       decisions an hour and a second before the close.
 *   K3  The exit quote must come from the session the horizon ends in. §C
 *       bounds no exit's age, and within one session that is §C's rule and
 *       stays open as its own question; across sessions it is a different
 *       defect: a quote file that ends on the decision's day, or a feed dark
 *       overnight, would let that day's close stand in for the next day's
 *       price and turn a one-day return into an intraday one under the D1
 *       label. Inside one session (M15, H1) the rule cannot bite, because the
 *       entry quote is already in it. It is checked on the latest quote
 *       itself, before the book is read, so an earlier session's last quote
 *       that is also one-sided is refused for the missing session, not
 *       blamed on the book.
 *   K6  An exit never reads a date inside H-001-v2's frozen holdout
 *       (`h001Windows.ts`), whatever quotes the caller supplied, and the
 *       refusal comes before any mark is taken. A decision on the last
 *       confirmatory day has its D1 exit on the holdout's first day; §A says
 *       the holdout is "not accessed for H-001-v2 at all", and an exploratory
 *       endpoint is not an exemption from that.
 *   K4  The units are the primary's: the matched A meta-events and the C
 *       controls the primary drew, measured at the longer horizon. Nothing is
 *       re-drawn or re-matched — the draw is the study's, not the endpoint's —
 *       and nothing is replaced: a control that cannot be measured is
 *       counted and the set's mean is over the ones that can (D3's rule); an A
 *       meta-event with no measurable control drops out, counted.
 *   K5  Each endpoint reports Δ_AC — the only primary estimand — with the
 *       primary's own day-clustered bootstrap and nothing else: no precision
 *       target, no verdict, `decides: false`. Δ_AB and Δ_AD are not computed
 *       at H1 or D1; adding estimands at exploratory horizons would be a
 *       search the text does not license.
 *
 * And one property stated rather than corrected: at these horizons the
 * outcome windows overlap. Meta-events are at least 15 minutes apart and an
 * H1 window is an hour, but those overlaps fall inside one day, which the
 * day-clustered bootstrap already treats as one cluster. A D1 window ends on
 * the next session, whose own meta-events are a different cluster, so D1's
 * interval can be narrower than its dependence warrants. Correcting it means
 * choosing a dependence model the text does not name; the payload says so.
 */
import { HORIZON_NOMINAL_MS } from '../persistence/types';
import { sessionOn } from '../flow-engine/calendar';
import { instantEt, marketDateOf } from '../market/civil';
import { h001ReturnOver, markAt, H001_ENTRY_LATENCY_MS } from './h001Marks';
import { H001_HOLDOUT, inWindow } from './h001Windows';
import type { QuoteSource } from './h001Marks';
import type { AMatch } from './h001Controls';
import { h001SecondaryInterval } from './h001Verdict';
import type { Interval, Observation } from './h001Verdict';

export type H001ExploratoryHorizon = 'H1' | 'D1';

/** K1: the grader's table, read rather than restated. */
export const H001_EXPLORATORY_HORIZON_MS: Readonly<Record<H001ExploratoryHorizon, number>> = Object.freeze({
  H1: HORIZON_NOMINAL_MS.H1,
  D1: HORIZON_NOMINAL_MS.D1,
});

/**
 * K2: whether an instant falls inside its market date's published regular
 * session. `unknown` separates "the calendar cannot say" (past its coverage,
 * or a time it cannot place) from "the market was shut".
 */
export function regularSessionAt(at: number): { ok: true; open: number } | { ok: false; unknown: boolean; why: string } {
  const date = marketDateOf(at);
  if (date === null) return { ok: false, unknown: true, why: 'the instant cannot be read in the market timezone' };
  const s = sessionOn(date);
  if (s.openHour === null || s.openMinute === null || s.closeHour === null || s.closeMinute === null) {
    return { ok: false, unknown: s.kind === 'UNKNOWN', why: s.basis };
  }
  const open = instantEt(date, s.openHour, s.openMinute);
  const close = instantEt(date, s.closeHour, s.closeMinute);
  if (open === null || close === null) return { ok: false, unknown: true, why: `the session bounds on ${date} could not be placed` };
  if (at < open) return { ok: false, unknown: false, why: `before the regular open on ${date}` };
  if (at > close) return { ok: false, unknown: false, why: `after the regular close on ${date}` };
  return { ok: true, open };
}

export type ExploratoryRefusal =
  | 'IN_HOLDOUT'                 // K6
  | 'OUTSIDE_SESSION'            // K2
  | 'SESSION_UNKNOWN'            // K2: the calendar cannot say
  | 'EXIT_FROM_EARLIER_SESSION'  // K3
  | 'NO_MARK';                   // §C refused the entry or exit mark

type Unit =
  | { ok: true; returnBp: number; exitAgeMs: number }
  | { ok: false; refusal: ExploratoryRefusal; why: string };

/** One unit — an A meta-event or a control — measured from its own anchor at `horizonMs` (K1–K3). */
function measure(anchor: number, quotes: QuoteSource, horizonMs: number): Unit {
  const exitAt = anchor + H001_ENTRY_LATENCY_MS + horizonMs;
  // K6, before any quote is read.
  const exitDate = marketDateOf(exitAt);
  if (exitDate !== null && inWindow(exitDate, H001_HOLDOUT)) {
    return { ok: false, refusal: 'IN_HOLDOUT',
      why: `the exit falls on ${exitDate}, inside the frozen holdout ${H001_HOLDOUT.from}..${H001_HOLDOUT.to} (K6)` };
  }
  const session = regularSessionAt(exitAt);
  if (!session.ok) return { ok: false, refusal: session.unknown ? 'SESSION_UNKNOWN' : 'OUTSIDE_SESSION', why: session.why };
  // K3 on the latest quote by the exit, whatever state its book is in: older
  // than the session's open means the session has no quote to stand for.
  const latest = markAt(quotes, exitAt, { requireAvailableBy: false, maxAgeMs: exitAt - session.open });
  if (!latest.ok && latest.refusal === 'STALE') {
    return { ok: false, refusal: 'EXIT_FROM_EARLIER_SESSION', why: `the latest quote by the exit is from before that session's open (K3)` };
  }
  const r = h001ReturnOver(anchor, quotes, horizonMs);
  if (r.status !== 'OK') return { ok: false, refusal: 'NO_MARK', why: r.status };
  return { ok: true, returnBp: r.returnBp, exitAgeMs: r.exitAgeMs };
}

export type ExploratoryRowStatus = 'MEASURED' | 'A_UNMEASURED' | 'NO_CONTROL_MEASURED';

export interface ExploratoryRow {
  metaEventId: string;
  date: string;
  status: ExploratoryRowStatus;
  /** Why r_A was not measured, when it was not. */
  refusal: ExploratoryRefusal | null;
  returnBp: number | null;
  controlsMeasured: number;
  controlsRefused: number;
  controlMeanBp: number | null;
  differenceBp: number | null;
}

export interface H001ExploratoryEndpoint {
  horizon: H001ExploratoryHorizon;
  horizonMs: number;
  /** The primary's matched A meta-events — the only ones Δ_AC is defined on. */
  considered: number;
  rows: ExploratoryRow[];
  /** One r_A − r̄_C per measured A meta-event. */
  differences: Observation[];
  estimateBp: number | null;
  ci95: Interval | null;
  n: { observations: number; days: number };
  refused: { aMetaEvents: Record<ExploratoryRefusal, number>; controls: Record<ExploratoryRefusal, number> };
  /**
   * §C bounds no exit's age; the oldest exit quote behind a reported
   * difference is reported, as `exitAgeMs` is at M15. Units that contribute
   * nothing — an A meta-event left with no measured control — are not in it.
   */
  maxExitAgeMs: number | null;
  notes: string[];
  decides: false;
}

const noRefusals = (): Record<ExploratoryRefusal, number> =>
  ({ IN_HOLDOUT: 0, OUTSIDE_SESSION: 0, SESSION_UNKNOWN: 0, EXIT_FROM_EARLIER_SESSION: 0, NO_MARK: 0 });

export function h001Exploratory(
  matches: readonly AMatch[],
  quotes: QuoteSource,
  horizon: H001ExploratoryHorizon,
  opts: { replicates?: number } = {},
): H001ExploratoryEndpoint {
  if (horizon !== 'H1' && horizon !== 'D1') throw new RangeError(`not an exploratory horizon: ${String(horizon)}`);
  const horizonMs = H001_EXPLORATORY_HORIZON_MS[horizon];
  const refused = { aMetaEvents: noRefusals(), controls: noRefusals() };
  const rows: ExploratoryRow[] = [];
  const differences: Observation[] = [];
  let considered = 0;
  let maxExitAgeMs: number | null = null;

  for (const m of matches) {
    if (m.status !== 'MATCHED') continue;
    considered++;
    const base = { metaEventId: m.metaEventId, date: m.date };
    const a = measure(m.anchor, quotes, horizonMs);
    if (!a.ok) {
      refused.aMetaEvents[a.refusal]++;
      rows.push({ ...base, status: 'A_UNMEASURED', refusal: a.refusal, returnBp: null,
        controlsMeasured: 0, controlsRefused: 0, controlMeanBp: null, differenceBp: null });
      continue;
    }
    const measured: Array<{ returnBp: number; exitAgeMs: number }> = [];
    let controlsRefused = 0;
    for (const c of m.controls) {
      const u = measure(c.anchor, quotes, horizonMs);
      if (u.ok) measured.push(u);
      else { refused.controls[u.refusal]++; controlsRefused++; }
    }
    if (measured.length === 0) {
      rows.push({ ...base, status: 'NO_CONTROL_MEASURED', refusal: null, returnBp: a.returnBp,
        controlsMeasured: 0, controlsRefused, controlMeanBp: null, differenceBp: null });
      continue;
    }
    // The ages behind this difference, and only those.
    for (const age of [a.exitAgeMs, ...measured.map((u) => u.exitAgeMs)]) {
      maxExitAgeMs = maxExitAgeMs === null ? age : Math.max(maxExitAgeMs, age);
    }
    const mean = measured.reduce((s, u) => s + u.returnBp, 0) / measured.length;
    const differenceBp = a.returnBp - mean;
    rows.push({ ...base, status: 'MEASURED', refusal: null, returnBp: a.returnBp,
      controlsMeasured: measured.length, controlsRefused, controlMeanBp: mean, differenceBp });
    differences.push({ date: m.date, valueBp: differenceBp });
  }

  const interval = h001SecondaryInterval(differences, opts);
  const notes = [
    `${horizon} is exploratory (§K): reported without multiplicity correction, and it supports no claim.`,
  ];
  if (horizon === 'D1') {
    notes.push('D1 windows end on the next session, whose meta-events form a different day cluster, '
      + 'so this interval can be narrower than its dependence warrants; no correction is applied (none is named).');
  }
  return {
    horizon, horizonMs, considered,
    rows, differences, estimateBp: interval.estimateBp, ci95: interval.ci95, n: interval.n,
    refused, maxExitAgeMs, notes, decides: false,
  };
}
