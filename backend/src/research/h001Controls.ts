/**
 * H-001-v2 §G, as code: the primary control C, and the matched differences
 * d_i = r_A − r̄_C that §C defines and `h001Verdict.ts` consumes.
 *
 * Matching is where a study quietly decides its own answer: a bucket boundary
 * nudged, a "close enough" match accepted, a control that happened to fall the
 * wrong way re-drawn. §G closes those doors in the text — exact matches only,
 * nothing coarsened, a fixed seed, more than 20% unmatched makes the study
 * DESCRIPTIVE — and this module is that text as a function, written before any
 * data exists so no boundary can have been chosen by looking.
 *
 * For each A meta-event, up to 5 SPY call executions are drawn without
 * replacement, seed 20260927, from those that are part of no A or B
 * meta-event and match it exactly on:
 *
 *   trading day; 60-minute ET bucket; DTE bucket {0, 1–2, 3–7, 8–30, 31+};
 *   moneyness K/S at the causal SPY midpoint {<0.97, 0.97–0.995,
 *   0.995–1.005, 1.005–1.03, >1.03}; premium {$50k–100k, $100k–250k,
 *   $250k–1M, ≥$1M}; any side.
 *
 * An A meta-event with no exact match is counted and dropped from Δ_AC.
 *
 * Readings this module had to make (each also in research/README.md). The
 * file states the buckets and leaves their edges, clocks and draw mechanics
 * open; each is named here so a reader can disagree with a choice instead of
 * discovering one.
 *
 *   M1  The 60-minute bucket is the ET clock hour of the anchor, [h:00, h+1:00).
 *       A session-anchored hour (09:30–10:29) is the other reading; the clock
 *       hour is what "ET bucket" names, and §G's D control uses the same one.
 *   M2  DTE is whole calendar days from the anchor's market date to the expiry
 *       date — the bucket {0} is "expires today", which a fractional time to
 *       the 16:00 settlement instant cannot express.
 *   M3  Every bucket is lower-inclusive: [0.97, 0.995), [1.03, ∞),
 *       [$100k, $250k). The premium row "≥$1M" fixes the convention for that
 *       axis, and one convention is used for all of them.
 *   M4  S, "the causal SPY midpoint", is the latest SPY quote stamped AND
 *       known by the anchor, no older than 2 s — §H's causal rule and bound,
 *       applied to the underlying. No such quote: no moneyness, no key, no
 *       match. A stale midpoint is not substituted.
 *   M5  An A meta-event is keyed by its FIRST signal — the one §B says it is
 *       measured from: that signal's contract, its cluster premium and its
 *       decisionAt. A control execution is keyed by its own contract, its
 *       premium (price × size × 100) and its availableAt, §C's anchor for it.
 *   M6  "Without replacement" is within one A meta-event's draw: its controls
 *       are distinct executions, and an execution may control more than one A
 *       meta-event. One PRNG stream seeded 20260927 is consumed in A order
 *       (date, startsAt, id) with each pool ordered by event id, so the draw
 *       is a function of the data alone.
 *   M7  "Measured the same way" is read as every §L rule that does not define
 *       group A: on the FINAL_CORRECTED tape and ACTIVE there; admitted by the
 *       detector; regular session under H001_V2_SESSION_RULE; contract OPEN;
 *       availableAt not an event-time lower bound; not synthetic; the same
 *       decision window; both §C marks. An execution failing any of these is
 *       removed BEFORE the draw, so a drawn control is never discarded
 *       afterwards — which would make the realised count depend on the order
 *       of the draw.
 *
 * Not implemented here, and a report built on it must say so: the trailing
 * 30-minute realised-volatility balance diagnostic (§G, decides nothing) and
 * the D control (§G, secondary).
 */
import type { TradeReportEvent } from '../events/types';
import type { TapeView } from '../events/eventLog';
import { detectorAdmission } from '../events/detector';
import { H001_V2_SESSION_RULE, researchEligibility } from '../market/researchEligibility';
import { contractSessionAt } from '../market/contractLifecycle';
import { addDays, marketDateOf, minutesEt } from '../market/civil';
import { premiumOf } from '../flow-engine/types';
import { h001Return, markAt, H001_ENTRY_MAX_AGE_MS } from './h001Marks';
import type { UnderlyingQuote } from './h001Marks';
import { h001DecisionWindow, H001_UNDERLYING } from './h001Eligibility';
import { H001_BOOTSTRAP_SEED, seededRandom } from './h001Verdict';
import type { Observation } from './h001Verdict';

/** §G: up to five C controls per A meta-event. */
export const H001_CONTROLS_PER_EVENT = 5;

export type DteBucket = '0' | '1-2' | '3-7' | '8-30' | '31+';
export type MoneynessBucket = '<0.97' | '0.97-0.995' | '0.995-1.005' | '1.005-1.03' | '>=1.03';
export type PremiumBucket = '50k-100k' | '100k-250k' | '250k-1M' | '>=1M';

export interface MatchKey {
  date: string;
  /** M1: the ET clock hour of the anchor, 0–23. */
  hourEt: number;
  dte: DteBucket;
  moneyness: MoneynessBucket;
  premium: PremiumBucket;
}

export type KeyResult = { ok: true; key: MatchKey } | { ok: false; why: string };

/** M2, M3. Null for a negative day count: a contract expired before the anchor has no bucket. */
export function dteBucket(days: number): DteBucket | null {
  if (!Number.isInteger(days) || days < 0) return null;
  if (days === 0) return '0';
  if (days <= 2) return '1-2';
  if (days <= 7) return '3-7';
  if (days <= 30) return '8-30';
  return '31+';
}

/** M3: lower-inclusive. */
export function moneynessBucket(ratio: number): MoneynessBucket | null {
  if (!(Number.isFinite(ratio) && ratio > 0)) return null;
  if (ratio < 0.97) return '<0.97';
  if (ratio < 0.995) return '0.97-0.995';
  if (ratio < 1.005) return '0.995-1.005';
  if (ratio < 1.03) return '1.005-1.03';
  return '>=1.03';
}

/** M3: lower-inclusive; below $50,000 there is no bucket, so no match. */
export function premiumBucket(premium: number): PremiumBucket | null {
  if (!Number.isFinite(premium) || premium < 50_000) return null;
  if (premium < 100_000) return '50k-100k';
  if (premium < 250_000) return '100k-250k';
  if (premium < 1_000_000) return '250k-1M';
  return '>=1M';
}

/** Whole calendar days from one ISO date to another, or null if either is unreadable. */
function calendarDays(from: string, to: string): number | null {
  if (addDays(from, 0) === null || addDays(to, 0) === null) return null;
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** M4: the causal SPY midpoint at an instant, or null. */
export function causalSpot(quotes: readonly UnderlyingQuote[], at: number): number | null {
  const m = markAt(quotes, at, { requireAvailableBy: true, maxAgeMs: H001_ENTRY_MAX_AGE_MS });
  return m.ok ? m.midpoint : null;
}

export interface KeyInput {
  anchor: number;
  expiry: string;
  strike: number;
  premium: number;
}

export function matchKeyOf(x: KeyInput, quotes: readonly UnderlyingQuote[]): KeyResult {
  const date = marketDateOf(x.anchor);
  const minutes = minutesEt(x.anchor);
  if (date === null || minutes === null) return { ok: false, why: 'the anchor cannot be read in the market timezone' };
  const days = calendarDays(date, x.expiry);
  const dte = days === null ? null : dteBucket(days);
  if (dte === null) return { ok: false, why: `no DTE bucket for expiry ${x.expiry} on ${date}` };
  const premium = premiumBucket(x.premium);
  if (premium === null) return { ok: false, why: `premium ${x.premium} is below every bucket` };
  const spot = causalSpot(quotes, x.anchor);
  if (spot === null) return { ok: false, why: 'no causal SPY midpoint at the anchor (M4)' };
  const moneyness = moneynessBucket(x.strike / spot);
  if (moneyness === null) return { ok: false, why: `no moneyness bucket for strike ${x.strike}` };
  return { ok: true, key: { date, hourEt: Math.floor(minutes / 60), dte, moneyness, premium } };
}

export function keyString(k: MatchKey): string {
  return `${k.date}|${k.hourEt}|${k.dte}|${k.moneyness}|${k.premium}`;
}

// ─── The control pool ────────────────────────────────────────────────────────

export interface Control {
  eventId: string;
  key: MatchKey;
  returnBp: number;
}

export interface PoolRejection {
  eventId: string;
  why: string;
}

/**
 * M7: every execution that could serve as a C control, keyed and measured.
 * `excludedEventIds` is the evidence of every signal in every A and B
 * meta-event — "not part of any A or B meta-event".
 */
export function controlPool(
  tape: TapeView,
  excludedEventIds: ReadonlySet<string>,
  quotes: readonly UnderlyingQuote[],
): { pool: Control[]; rejected: PoolRejection[] } {
  // §J: the primary tape is the final one. An as-known view could admit a
  // trade that was later cancelled, and a cancelled trade was not an execution.
  if (tape.basis !== 'FINAL_CORRECTED') throw new RangeError('controls are drawn from the FINAL_CORRECTED tape (§J)');
  const pool: Control[] = [];
  const rejected: PoolRejection[] = [];
  for (const t of tape.trades) {
    const e: TradeReportEvent = t.event;
    if (e.instrument.underlying !== H001_UNDERLYING || e.instrument.right !== 'C') continue;
    if (excludedEventIds.has(e.eventId)) continue;
    const no = (why: string) => { rejected.push({ eventId: e.eventId, why }); };
    if (t.state !== 'ACTIVE') { no(`trade state ${t.state} on the final tape`); continue; }
    const a = detectorAdmission({ kind: 'ORDERED', event: e, finalizedAt: e.availableAt, orderBasis: 'EVENT_TIME' });
    if (!a.admit) { no(`not admitted: ${a.reason}`); continue; }
    if (researchEligibility(e.sessionEvidence, e.eventTime, H001_V2_SESSION_RULE).eligibility !== 'INCLUDED') {
      no('session eligibility is not INCLUDED'); continue;
    }
    const life = contractSessionAt(e.instrument.underlying, e.instrument.expiry, e.eventTime);
    if (life.state !== 'OPEN') { no(`contract ${life.state}`); continue; }
    if (e.availableAtBasis === 'EVENT_TIME_LOWER_BOUND') { no('availableAt is only the event time'); continue; }
    if (e.synthetic) { no('synthetic'); continue; }
    const w = h001DecisionWindow(e.availableAt);
    if (!w.ok) { no(`decision window: ${w.unknown ?? w.why}`); continue; }
    const key = matchKeyOf({
      anchor: e.availableAt, expiry: e.instrument.expiry, strike: e.instrument.strike,
      premium: premiumOf(e.price, e.size),
    }, quotes);
    if (!key.ok) { no(`no match key: ${key.why}`); continue; }
    const r = h001Return(e.availableAt, quotes);
    if (r.status !== 'OK') { no(`no §C return: ${r.status}`); continue; }
    pool.push({ eventId: e.eventId, key: key.key, returnBp: r.returnBp });
  }
  return { pool, rejected };
}

// ─── Matching ────────────────────────────────────────────────────────────────

/** An A meta-event, described by its first signal (M5). */
export interface AMetaEvent {
  metaEventId: string;
  /** The first signal's decisionAt — where the meta-event is measured from (§B). */
  startsAt: number;
  expiry: string;
  strike: number;
  /** The first signal's cluster premium, dollars. */
  premium: number;
}

export type AMatchStatus = 'MATCHED' | 'NO_KEY' | 'NO_MATCH';

export interface AMatch {
  metaEventId: string;
  date: string;
  status: AMatchStatus;
  key: MatchKey | null;
  why: string | null;
  returnBp: number;
  controls: Control[];
  /** r̄_C, when matched. */
  controlMeanBp: number | null;
  /** d = r_A − r̄_C, when matched. */
  differenceBp: number | null;
}

export interface H001Matching {
  matches: AMatch[];
  /** One d per matched A meta-event — `H001Inputs.primary`. */
  primary: Observation[];
  /** A meta-events with no exact C match, NO_KEY included — `H001Inputs.unmatchedA`. */
  unmatchedA: number;
  poolSize: number;
  rejected: PoolRejection[];
}

export function matchControls(input: {
  a: readonly AMetaEvent[];
  tape: TapeView;
  /** Evidence of every signal in every A and B meta-event. */
  excludedEventIds: ReadonlySet<string>;
  quotes: readonly UnderlyingQuote[];
}): H001Matching {
  const { pool, rejected } = controlPool(input.tape, input.excludedEventIds, input.quotes);
  const byKey = new Map<string, Control[]>();
  for (const c of pool) {
    const k = keyString(c.key);
    const list = byKey.get(k) ?? [];
    list.push(c);
    byKey.set(k, list);
  }
  for (const list of byKey.values()) list.sort((x, y) => (x.eventId < y.eventId ? -1 : x.eventId > y.eventId ? 1 : 0));

  const rand = seededRandom(H001_BOOTSTRAP_SEED);
  const ordered = [...input.a].map((a) => {
    const date = marketDateOf(a.startsAt);
    if (date === null) throw new RangeError(`meta-event ${a.metaEventId} has an unreadable start`);
    return { a, date };
  }).sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0)
    || x.a.startsAt - y.a.startsAt
    || (x.a.metaEventId < y.a.metaEventId ? -1 : x.a.metaEventId > y.a.metaEventId ? 1 : 0));

  const matches: AMatch[] = [];
  for (const { a, date } of ordered) {
    const r = h001Return(a.startsAt, input.quotes);
    // §L admits a signal only when both marks exist, so an A meta-event
    // without a return is a pipeline defect, not an observation to drop.
    if (r.status !== 'OK') throw new RangeError(`A meta-event ${a.metaEventId} has no §C return (${r.status})`);
    const key = matchKeyOf({ anchor: a.startsAt, expiry: a.expiry, strike: a.strike, premium: a.premium }, input.quotes);
    const base = { metaEventId: a.metaEventId, date, returnBp: r.returnBp };
    if (!key.ok) {
      matches.push({ ...base, status: 'NO_KEY', key: null, why: key.why, controls: [], controlMeanBp: null, differenceBp: null });
      continue;
    }
    const candidates = [...(byKey.get(keyString(key.key)) ?? [])];
    if (candidates.length === 0) {
      matches.push({ ...base, status: 'NO_MATCH', key: key.key, why: 'no control matches exactly; nothing is coarsened (§G)',
        controls: [], controlMeanBp: null, differenceBp: null });
      continue;
    }
    // Partial Fisher–Yates: the first `take` positions are a uniform draw
    // without replacement from the pool (M6).
    const take = Math.min(H001_CONTROLS_PER_EVENT, candidates.length);
    for (let i = 0; i < take; i++) {
      const j = i + Math.floor(rand() * (candidates.length - i));
      [candidates[i], candidates[j]] = [candidates[j]!, candidates[i]!];
    }
    const controls = candidates.slice(0, take);
    const mean = controls.reduce((s, c) => s + c.returnBp, 0) / controls.length;
    matches.push({ ...base, status: 'MATCHED', key: key.key, why: null, controls,
      controlMeanBp: mean, differenceBp: r.returnBp - mean });
  }

  return {
    matches,
    primary: matches.filter((m) => m.status === 'MATCHED').map((m) => ({ date: m.date, valueBp: m.differenceBp! })),
    unmatchedA: matches.filter((m) => m.status !== 'MATCHED').length,
    poolSize: pool.length,
    rejected,
  };
}
