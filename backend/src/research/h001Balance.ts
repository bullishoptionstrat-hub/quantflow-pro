/**
 * H-001-v2 §G's balance diagnostic, as code: "The trailing 30-minute realized
 * volatility of A versus C is reported as a balance diagnostic; a standardized
 * mean difference above 0.1 is flagged."
 *
 * It decides nothing. Same-day, same-hour exact matching is §G's control for
 * regime; this reports whether the matched set kept it, and a flag is a thing
 * for a reader to see, never a rule that changes the verdict. Nothing in
 * `h001Verdict.ts` reads it, which a test holds.
 *
 * §G names the quantity and the threshold and leaves the measurement open.
 * The readings, each also in research/README.md:
 *
 *   V1  Realised volatility is √Σ r_k² over the 30 one-minute log returns of
 *       the SPY NBBO midpoint, in bp, on a grid ending at the unit's §C entry
 *       instant (anchor + 1 s): 31 marks at t_entry − 30 min + k·1 min. One
 *       minute, because it is the coarsest step that still gives thirty
 *       returns — enough for a dispersion — and far enough above the quote
 *       rate that bid-ask bounce does not dominate a midpoint series.
 *   V2  Each grid mark obeys §C's entry rule: the latest quote both stamped
 *       and known by the instant, no older than 2 s, a two-sided uncrossed
 *       book. The window precedes the event, so it must be causal; and a
 *       stale mark repeats a price, which reads as zero return and biases
 *       volatility low — the flattering direction for a balance check.
 *   V3  A unit with any refused mark is unmeasurable: excluded and counted,
 *       never filled. So is a unit whose window starts before its session's
 *       published regular open — every event in the first 30 minutes — and
 *       one whose session the calendar cannot place. That is a rule, not a
 *       consequence of the quotes: without it, whether pre-market quotes
 *       entered the window would depend on where a vendor's file began, and
 *       the same code would report different coverage on two vendors.
 *   V4  The comparison is over matched pairs — the set Δ_AC is computed on. An
 *       A meta-event whose own volatility is unmeasurable, or none of whose
 *       controls is measurable, leaves the comparison with its controls.
 *       Each remaining A has weight 1 and each of its k measured controls
 *       weight 1/k, so an A with five controls does not count five times on
 *       the C side (the usual convention for variable-ratio matching).
 *   V5  SMD = (mean_A − mean_C) / √((var_A + var_C) / 2), with both variances
 *       on the (Σw − 1) divisor, and flagged when |SMD| > 0.1: §G says
 *       "above 0.1", and imbalance in either direction is imbalance.
 */
import { markAt, H001_ENTRY_LATENCY_MS, H001_ENTRY_MAX_AGE_MS } from './h001Marks';
import type { UnderlyingQuote } from './h001Marks';
import type { AMatch } from './h001Controls';
import { marketDateOf, sessionOn } from '../flow-engine/calendar';
import { instantEt } from '../market/civil';

/** §G: trailing 30 minutes. */
export const H001_RV_WINDOW_MS = 30 * 60_000;
/** V1: one-minute returns. */
export const H001_RV_STEP_MS = 60_000;
/** §G: a standardized mean difference above this is flagged. */
export const H001_SMD_FLAG = 0.1;

export type RvResult = { ok: true; rvBp: number } | { ok: false; why: string };

/** V1–V3: the trailing realised volatility of a unit measured from `anchor`. */
export function trailingRv(anchor: number, quotes: readonly UnderlyingQuote[]): RvResult {
  if (!Number.isFinite(anchor)) throw new RangeError('the anchor must be an instant');
  const end = anchor + H001_ENTRY_LATENCY_MS;
  const start = end - H001_RV_WINDOW_MS;
  // V3: the window lies inside the regular session, whatever quotes exist.
  const date = marketDateOf(end);
  const s = date === null ? null : sessionOn(date);
  const open = date === null || s === null || s.openHour === null || s.openMinute === null
    ? null : instantEt(date, s.openHour, s.openMinute);
  if (open === null) return { ok: false, why: 'the calendar cannot place this session\'s regular open' };
  if (start < open) return { ok: false, why: `the 30-minute window starts ${Math.ceil((open - start) / 60_000)} min before the regular open` };
  const steps = H001_RV_WINDOW_MS / H001_RV_STEP_MS;
  const mids: number[] = [];
  for (let k = 0; k <= steps; k++) {
    const at = start + k * H001_RV_STEP_MS;
    const m = markAt(quotes, at, { requireAvailableBy: true, maxAgeMs: H001_ENTRY_MAX_AGE_MS });
    if (!m.ok) return { ok: false, why: `grid mark ${k} of ${steps} (${new Date(at).toISOString()}): ${m.refusal} — ${m.why}` };
    mids.push(m.midpoint);
  }
  let ss = 0;
  for (let k = 1; k < mids.length; k++) {
    const r = 10_000 * Math.log(mids[k]! / mids[k - 1]!);
    ss += r * r;
  }
  return { ok: true, rvBp: Math.sqrt(ss) };
}

export interface H001BalanceResult {
  meanABp: number | null;
  meanCBp: number | null;
  sdABp: number | null;
  sdCBp: number | null;
  smd: number | null;
  /** |SMD| > 0.1 (V5); null when there is no SMD. */
  flagged: boolean | null;
  n: {
    /** Matched A meta-events compared, and their measured controls. */
    pairs: number;
    controls: number;
    /** V4: matched A meta-events left out, and why. */
    unmeasuredA: number;
    noMeasuredControl: number;
    /** Controls of compared A meta-events whose own window was unmeasurable. */
    unmeasuredControls: number;
  };
  reasons: string[];
  decides: false;
}

/** V4, V5: the balance of the matched set. */
export function h001VolBalance(matches: readonly AMatch[], quotes: readonly UnderlyingQuote[]): H001BalanceResult {
  const pairs: Array<{ a: number; c: number[] }> = [];
  const n = { pairs: 0, controls: 0, unmeasuredA: 0, noMeasuredControl: 0, unmeasuredControls: 0 };
  for (const m of matches) {
    if (m.status !== 'MATCHED') continue;
    if (m.controls.length === 0) throw new RangeError(`matched A meta-event ${m.metaEventId} has no controls`);
    const rvA = trailingRv(m.anchor, quotes);
    if (!rvA.ok) { n.unmeasuredA++; continue; }
    const rvs: number[] = [];
    let missing = 0;
    for (const ctl of m.controls) {
      const r = trailingRv(ctl.anchor, quotes);
      if (r.ok) rvs.push(r.rvBp); else missing++;
    }
    if (rvs.length === 0) { n.noMeasuredControl++; continue; }
    n.unmeasuredControls += missing;
    pairs.push({ a: rvA.rvBp, c: rvs });
  }
  return smdOfPairs(pairs, n);
}

/**
 * V4, V5 on measured pairs: each A weight 1, each of its k controls weight
 * 1/k, both variances on the (Σw − 1) divisor.
 */
export function smdOfPairs(
  pairs: ReadonlyArray<{ a: number; c: readonly number[] }>,
  dropped: Pick<H001BalanceResult['n'], 'unmeasuredA' | 'noMeasuredControl' | 'unmeasuredControls'> =
    { unmeasuredA: 0, noMeasuredControl: 0, unmeasuredControls: 0 },
): H001BalanceResult {
  const n = { ...dropped, pairs: pairs.length, controls: pairs.reduce((s, p) => s + p.c.length, 0) };
  const reasons: string[] = [];
  if (n.unmeasuredA > 0) reasons.push(`${n.unmeasuredA} matched A meta-event(s) had an unmeasurable 30-minute window and are left out (V3, V4)`);
  if (n.noMeasuredControl > 0) reasons.push(`${n.noMeasuredControl} matched A meta-event(s) had no measurable control and are left out (V4)`);
  const none = { meanABp: null, meanCBp: null, sdABp: null, sdCBp: null, smd: null, flagged: null, n, reasons, decides: false as const };
  if (pairs.some((p) => p.c.length === 0)) throw new RangeError('a pair with no control has no C side');
  if (pairs.length < 2) {
    reasons.push(`${pairs.length} comparable pair(s): a standardized difference needs at least two`);
    return none;
  }
  const a = pairs.map((p) => p.a);
  const c = pairs.flatMap((p) => p.c.map((x) => ({ x, w: 1 / p.c.length })));
  const meanA = a.reduce((s, x) => s + x, 0) / a.length;
  const varA = a.reduce((s, x) => s + (x - meanA) ** 2, 0) / (a.length - 1);
  const sw = pairs.length; // each pair's control weights sum to 1
  const meanC = c.reduce((s, o) => s + o.w * o.x, 0) / sw;
  const varC = c.reduce((s, o) => s + o.w * (o.x - meanC) ** 2, 0) / (sw - 1);
  const pooled = Math.sqrt((varA + varC) / 2);
  const base = { meanABp: meanA, meanCBp: meanC, sdABp: Math.sqrt(varA), sdCBp: Math.sqrt(varC), n, reasons, decides: false as const };
  if (!(pooled > 0)) {
    reasons.push('both groups have zero spread in realised volatility: a standardized difference is undefined');
    return { ...base, smd: null, flagged: null };
  }
  const smd = (meanA - meanC) / pooled;
  const flagged = Math.abs(smd) > H001_SMD_FLAG;
  if (flagged) reasons.push(`|SMD| ${Math.abs(smd).toFixed(3)} exceeds ${H001_SMD_FLAG}: the matched set is not balanced on trailing volatility (§G)`);
  return { ...base, smd, flagged };
}
