/**
 * H-001-v2, end to end: the one function that turns a tape, its quotes and the
 * candidate signals into the study's report.
 *
 * Every piece below already existed and was tested alone — §L eligibility,
 * §B meta-events, §C marks, §G's C and D draws, the §F/§K verdict — and
 * nothing in `src/` called them together. That is this repository's recurring
 * failure shape: correct code that nothing reaches reads exactly like a
 * working analysis. §A also needs it to exist: the code freeze records ONE
 * commit hash for "the analysis", and until now there was no single analysis
 * for a hash to name.
 *
 * This module decides nothing the frozen text or the modules it calls have not
 * already decided, with five readings of its own, each open to challenge
 * before any data is read:
 *
 *   X1  Meta-events are formed per group: A signals with A signals, B with B.
 *       §B says "qualifying signals" and §G defines A and B as "the same, as
 *       meta-events"; a meta-event mixing a buy and a sell has no group, so
 *       it could enter neither estimand. An A and a B meta-event may overlap
 *       in time; within a group they never do.
 *   X2  The meta-event window is §C's horizon, 15 minutes, read from its one
 *       home (`H001_HORIZON_MS`) so the window that keeps outcome windows
 *       apart and the horizon that defines them cannot disagree.
 *   X3  A signal's §C marks are measured from its own decisionAt — §L asks
 *       whether "entry and exit marks both [are] available under §C's rules"
 *       of the signal, not of the meta-event that later absorbs it. A
 *       meta-event is measured from its first signal (§B), which §L therefore
 *       already admitted with both marks.
 *   X4  A single-leg signal's contract is its evidence's one instrument. §L
 *       already excludes evidence spanning two contracts, so the throw here
 *       is a backstop for a rule owned elsewhere, never a second copy of it.
 *   X5  "Not part of any A or B meta-event" (§G) is the evidence of every
 *       signal absorbed into one — not only each meta-event's first signal.
 *
 * §I's sensitivities are re-runs of this same pipeline on changed inputs,
 * reported beside the primary and deciding nothing (§I: "reported always,
 * deciding nothing"). Two more readings, for the $100k premium floor:
 *
 *   S1  The floor replaces §L's $50k at the candidate step, so meta-events are
 *       re-formed from the signals that clear it — a $70k signal that opened
 *       a window no longer opens it. Its prints stop being "part of any A or
 *       B meta-event" and so may enter the C pool; they can never match,
 *       because every surviving A meta-event's premium bucket is ≥ $100k and
 *       a print's premium cannot exceed its cluster's.
 *   S2  A sensitivity is the whole pipeline — controls, verdict rule, §K cap —
 *       so its verdict is comparable with the primary's. It is labelled, it
 *       carries `decides: false`, and the primary is computed without
 *       reference to it, which a test holds.
 *
 * What the report does NOT contain is listed on it, in `absent`, because a
 * report that is silent about a missing diagnostic reads as one that ran it.
 */
import type { TapeView } from '../events/eventLog';
import { groupMetaEvents } from './metaEvents';
import type { MetaEvent } from './metaEvents';
import { h001Eligibility } from './h001Eligibility';
import type { H001Candidate, H001Context, H001Eligibility, H001Rule } from './h001Eligibility';
import { h001Return, quoteBook, H001_HORIZON_MS } from './h001Marks';
import type { UnderlyingQuote } from './h001Marks';
import { matchClockControls, matchControls } from './h001Controls';
import type { AMetaEvent, H001ClockMatching, H001Matching } from './h001Controls';
import { h001SecondaryInterval, h001Verdict } from './h001Verdict';
import { h001Cr2Interval } from './h001Cr2';
import type { H001Cr2Result } from './h001Cr2';
import { h001VolBalance } from './h001Balance';
import type { H001BalanceResult } from './h001Balance';
import type { H001Result, Interval, Observation } from './h001Verdict';

/** A signal as the study receives it; `marks` is measured here (X3), never supplied. */
export type H001Signal = Omit<H001Candidate, 'marks'>;

export interface H001AnalysisInput {
  signals: readonly H001Signal[];
  /** The FINAL_CORRECTED view (§J primary) — the control pool is drawn from it. */
  tape: TapeView;
  /** One provider's SPY NBBO (§C). */
  quotes: readonly UnderlyingQuote[];
  ctx: H001Context;
  /** §K: whether classification error has been measured against a truth set. */
  truthSetAvailable: boolean;
  /** Tests only; a study runs the frozen 10,000. */
  replicates?: number;
}

export interface H001MetaEventRow {
  metaEventId: string;
  group: 'A' | 'B';
  date: string;
  startsAt: number;
  signalIds: string[];
  returnBp: number;
  /** §C sets no exit-age bound; reported so a quiet feed is visible (see h001Marks). */
  exitAgeMs: number;
}

/** Diagnostics the frozen text names that this report does not compute. */
export const H001_ABSENT: ReadonlyArray<{ item: string; section: string; decides: boolean }> = [
  { item: 'sensitivity: staleness bounds of 1 s and 5 s', section: '§I', decides: false },
  { item: 'sensitivity and §J secondary: the as-known replay with cancelled trades included', section: '§I, §J', decides: false },
  { item: 'exploratory endpoints H1 and D1', section: '§K', decides: false },
];

export interface H001Report {
  eligibility: {
    considered: number;
    included: { A: number; B: number };
    excluded: number;
    unknown: number;
    /** How many candidates each rule failed or could not establish; a candidate counts once per rule. */
    byRule: Partial<Record<H001Rule, { fail: number; unknown: number }>>;
    rows: H001Eligibility[];
  };
  metaEvents: H001MetaEventRow[];
  primary: H001Result;
  /** §D's cross-check on the same matched differences as `primary` — decides nothing. */
  cr2: H001Cr2Result;
  controls: Pick<H001Matching, 'matches' | 'poolSize' | 'rejected' | 'unmatchedA'>;
  /** §G's trailing-volatility balance of the matched set — decides nothing. */
  balance: H001BalanceResult;
  clock: H001ClockMatching & {
    /** Δ_AD — secondary, decides nothing (§K). */
    deltaAD: { estimateBp: number | null; ci95: Interval | null; n: { observations: number; days: number } };
  };
  sensitivities: {
    premiumFloor: H001Sensitivity & { floor: number; belowFloor: number };
  };
  absent: typeof H001_ABSENT;
}

/** §I: one sensitivity re-run, reported beside the primary. */
export interface H001Sensitivity {
  included: { A: number; B: number };
  metaEvents: { A: number; B: number };
  unmatchedA: number;
  primary: H001Result;
  cr2: H001Cr2Result;
  decides: false;
}

/** §I: the alternative premium floor. */
export const H001_SENSITIVITY_PREMIUM_FLOOR = 100_000;

/** The pipeline without its sensitivities — what the primary is, and what each sensitivity re-runs. */
export type H001Core = Omit<H001Report, 'sensitivities'>;

/** X4: the contract of a single-leg signal. */
function contractOf(s: H001Signal): { expiry: string; strike: number } {
  const keys = new Set(s.evidence.map((e) => `${e.instrument.expiry}|${e.instrument.strike}|${e.instrument.right}`));
  if (keys.size !== 1) throw new RangeError(`signal ${s.signalId} is single-leg but its evidence names ${keys.size} contracts`);
  const i = s.evidence[0]!.instrument;
  return { expiry: i.expiry, strike: i.strike };
}

export function runH001Analysis(input: H001AnalysisInput): H001Report {
  const core = analyseH001(input);
  // S1: the floor is applied to candidates, before §L and §B.
  const floor = H001_SENSITIVITY_PREMIUM_FLOOR;
  const kept = input.signals.filter((s) => Number.isFinite(s.totalPremium) && s.totalPremium >= floor);
  const p = analyseH001({ ...input, signals: kept });
  return {
    ...core,
    sensitivities: {
      premiumFloor: { floor, belowFloor: input.signals.length - kept.length, ...sensitivityOf(p) },
    },
    absent: core.absent,
  };
}

function sensitivityOf(r: H001Core): H001Sensitivity {
  const count = (g: 'A' | 'B') => r.metaEvents.filter((m) => m.group === g).length;
  return {
    included: r.eligibility.included,
    metaEvents: { A: count('A'), B: count('B') },
    unmatchedA: r.controls.unmatchedA,
    primary: r.primary,
    cr2: r.cr2,
    decides: false,
  };
}

/** The primary pipeline. Exported so a test can hold the primary to it; a study calls `runH001Analysis`. */
export function analyseH001(input: H001AnalysisInput): H001Core {
  // Indexed once: every mark below reads the same book (see h001Marks.ts).
  const quotes = quoteBook(input.quotes);
  // §L, with X3's marks.
  const rows: H001Eligibility[] = [];
  const included = { A: [] as H001Signal[], B: [] as H001Signal[] };
  const byRule: H001Report['eligibility']['byRule'] = {};
  const seen = new Set<string>();
  for (const s of input.signals) {
    if (seen.has(s.signalId)) throw new RangeError(`signal ${s.signalId} is listed twice`);
    seen.add(s.signalId);
    const r = h001Return(s.decisionAt, quotes);
    const marks = { entry: r.status !== 'NO_ENTRY_MARK', exit: r.status === 'OK' };
    const e = h001Eligibility({ ...s, marks }, input.ctx);
    rows.push(e);
    for (const rule of new Set(e.findings.map((f) => f.rule))) {
      const tally = byRule[rule] ?? { fail: 0, unknown: 0 };
      if (e.findings.some((f) => f.rule === rule && f.outcome === 'FAIL')) tally.fail++;
      else tally.unknown++;
      byRule[rule] = tally;
    }
    if (e.verdict === 'INCLUDED') included[e.group!].push(s);
  }

  // §B per group (X1, X2).
  const bySignal = new Map(input.signals.map((s) => [s.signalId, s]));
  const metaRows: H001MetaEventRow[] = [];
  const metaOf = (group: 'A' | 'B'): Array<MetaEvent & { metaEventId: string }> =>
    groupMetaEvents(included[group].map((s) => ({ signalId: s.signalId, decisionAt: s.decisionAt })), H001_HORIZON_MS)
      .map((m) => ({ ...m, metaEventId: `${group}:${m.signalIds[0]}` }));
  const meta = { A: metaOf('A'), B: metaOf('B') };
  const groupReturns = { A: [] as Observation[], B: [] as Observation[] };
  for (const group of ['A', 'B'] as const) {
    for (const m of meta[group]) {
      const r = h001Return(m.startsAt, quotes);
      // X3: the first signal was admitted with both marks at this very instant.
      if (r.status !== 'OK') throw new RangeError(`meta-event ${m.metaEventId} has no §C return (${r.status})`);
      metaRows.push({ metaEventId: m.metaEventId, group, date: m.date, startsAt: m.startsAt,
        signalIds: m.signalIds, returnBp: r.returnBp, exitAgeMs: r.exitAgeMs });
      groupReturns[group].push({ date: m.date, valueBp: r.returnBp });
    }
  }

  // §G: C and D. X5: every absorbed signal's evidence is out of the pool.
  const excludedEventIds = new Set<string>();
  for (const m of [...meta.A, ...meta.B]) {
    for (const id of m.signalIds) for (const e of bySignal.get(id)!.evidence) excludedEventIds.add(e.eventId);
  }
  const a: AMetaEvent[] = meta.A.map((m) => {
    const first = bySignal.get(m.signalIds[0]!)!;
    return { metaEventId: m.metaEventId, startsAt: m.startsAt, ...contractOf(first), premium: first.totalPremium };
  });
  const c = matchControls({ a, tape: input.tape, excludedEventIds, quotes });
  const d = matchClockControls({ a, quotes });

  const opts = input.replicates === undefined ? {} : { replicates: input.replicates };
  const primary = h001Verdict({
    primary: c.primary, unmatchedA: c.unmatchedA,
    groupA: groupReturns.A, groupB: groupReturns.B,
    truthSetAvailable: input.truthSetAvailable,
  }, opts);

  // Rules in a fixed order, so the report's bytes do not depend on which
  // candidate happened to fail a rule first.
  const byRuleSorted: H001Report['eligibility']['byRule'] = {};
  for (const k of (Object.keys(byRule) as H001Rule[]).sort()) byRuleSorted[k] = byRule[k];

  return {
    eligibility: {
      considered: rows.length,
      included: { A: included.A.length, B: included.B.length },
      excluded: rows.filter((r) => r.verdict === 'EXCLUDED').length,
      unknown: rows.filter((r) => r.verdict === 'UNKNOWN').length,
      byRule: byRuleSorted,
      rows,
    },
    metaEvents: metaRows,
    primary,
    cr2: h001Cr2Interval(c.primary),
    controls: { matches: c.matches, poolSize: c.poolSize, rejected: c.rejected, unmatchedA: c.unmatchedA },
    balance: h001VolBalance(c.matches, quotes),
    clock: { ...d, deltaAD: h001SecondaryInterval(d.differences, opts) },
    absent: H001_ABSENT,
  };
}
