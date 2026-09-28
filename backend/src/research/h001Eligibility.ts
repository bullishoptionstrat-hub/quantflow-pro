/**
 * H-001-v2 §L, as code: which signals enter the study, and which group.
 *
 * `research/hypotheses/H-001-v2-aggressive-call-buying-spy.md` froze the
 * eligibility rules on 2026-09-27, before any real data existed. Writing them
 * down as a function now — still before any data — is the point: an exclusion
 * implemented after the first result has been seen is an exclusion that can be
 * tuned to it. The hypothesis says the analysis is implemented and run on the
 * DEVELOPMENT days only and then frozen by commit hash; this module is the part
 * of that analysis that decides the sample.
 *
 * Three outcomes, never two:
 *
 *   INCLUDED  every rule was checked and every rule passed
 *   EXCLUDED  at least one rule definitely failed
 *   UNKNOWN   nothing definitely failed, but at least one rule could not be
 *             established — a session nobody can read, a calendar past its
 *             coverage, an as-known revision where a final-tape one is needed.
 *             It is not in the sample. Uncertainty resolves to refusal here as
 *             it does everywhere else in this tree, and it is counted apart
 *             from EXCLUDED so a sample shrinking for want of evidence is
 *             visible rather than folded into "failed a rule".
 *
 * Every failing rule is reported, not the first: a candidate that fails three
 * rules and has one fixed is still out, and a report naming one reason would
 * say otherwise.
 *
 * What this module deliberately does NOT do: select marks (§C), match controls
 * (§G), or build meta-events (§B, `metaEvents.ts`). It takes whether the marks
 * exist as an input rather than choosing them, so the one place that chooses a
 * mark is the one place that is tested for look-ahead.
 */
import type { InferredSide, OptionRight } from '../flow-engine/types';
import type { TradeReportEvent } from '../events/types';
import { detectorAdmission } from '../events/detector';
import type { SignalRevision } from '../events/signalRevision';
import { H001_V2_SESSION_RULE, researchEligibility } from '../market/researchEligibility';
import { contractSessionAt } from '../market/contractLifecycle';
import { marketDateOf, instantEt } from '../market/civil';
import { sessionOn } from '../flow-engine/calendar';
import { importPermitted } from '../provenance/researchManifest';
import type { DatasetRightsManifest } from '../provenance/researchManifest';
import type { BusinessMode } from '../provenance/rights';

/** §L: the underlying. */
export const H001_UNDERLYING = 'SPY';
/** §L: premium ≥ $50,000. */
export const H001_PREMIUM_FLOOR = 50_000;
/** §C: t_entry = decisionAt + 1 s. */
export const H001_ENTRY_LATENCY_MS = 1_000;
/** §C: t_exit = t_entry + 15 min, the only primary endpoint (§K). */
export const H001_HORIZON_MS = 15 * 60_000;

export type H001Group = 'A' | 'B';
export type H001Verdict = 'INCLUDED' | 'EXCLUDED' | 'UNKNOWN';

export type H001Rule =
  | 'underlying'
  | 'single-leg-call'
  | 'side'
  | 'premium'
  | 'detector-admission'
  | 'session'
  | 'decision-window'
  | 'contract-lifecycle'
  | 'availability-basis'
  | 'synthetic'
  | 'rights'
  | 'final-tape'
  | 'marks';

export interface H001Candidate {
  signalId: string;
  underlying: string;
  /** Every leg of the signal: contract right and side. */
  legs: ReadonlyArray<{ right: OptionRight; side: InferredSide }>;
  /** The engine's dominant side. */
  side: InferredSide;
  /** Cluster premium, dollars. */
  totalPremium: number;
  decisionAt: number;
  synthetic: boolean;
  /** The V2 trade events the signal was formed from. */
  evidence: readonly TradeReportEvent[];
  /** The signal's revision from the FINAL_CORRECTED view (§J primary tape). */
  finalRevision: SignalRevision;
  manifest: DatasetRightsManifest | null;
  /** Whether §C's entry and exit marks both exist. Chosen elsewhere, never here. */
  marks: { entry: boolean; exit: boolean };
}

export interface H001Finding {
  rule: H001Rule;
  outcome: 'FAIL' | 'UNKNOWN';
  why: string;
}

export interface H001Eligibility {
  signalId: string;
  verdict: H001Verdict;
  /** Set only when INCLUDED. */
  group: H001Group | null;
  findings: H001Finding[];
}

export interface H001Context {
  /** The business mode the study runs under; the manifest must have been read for it. */
  mode: BusinessMode;
  /** Passed in so a verdict is reproducible. */
  today: string;
}

/**
 * The decision window: open ≤ decisionAt, and the M15 exit falls inside the
 * regular session. §L writes it as "09:30 to 15:45 ET (12:45 on an early
 * close)" and gives the reason in the same line — "so the M15 exit falls inside
 * the underlying's regular session". The bound is computed from that reason
 * rather than from the literal, because §C adds a one-second latency before the
 * fifteen minutes: a decision at exactly 15:45:00 exits at 16:00:01, which the
 * stated reason excludes. Both bounds come off the calendar, never a constant,
 * so a half day is 12:45 without a special case.
 */
function decisionWindow(decisionAt: number): { ok: boolean; unknown?: string; why: string } {
  const date = marketDateOf(decisionAt);
  if (date === null) return { ok: false, unknown: 'the decision time cannot be read in the market timezone', why: '' };
  const s = sessionOn(date);
  if (s.openHour === null || s.openMinute === null || s.closeHour === null || s.closeMinute === null) {
    if (s.kind === 'UNKNOWN') return { ok: false, unknown: s.basis, why: '' };
    return { ok: false, why: `${s.basis}; no regular session to decide in` };
  }
  const open = instantEt(date, s.openHour, s.openMinute);
  const close = instantEt(date, s.closeHour, s.closeMinute);
  if (open === null || close === null) return { ok: false, unknown: `the session bounds on ${date} could not be placed`, why: '' };
  const exit = decisionAt + H001_ENTRY_LATENCY_MS + H001_HORIZON_MS;
  if (decisionAt < open) return { ok: false, why: 'decided before the regular open' };
  if (exit > close) return { ok: false, why: 'the M15 exit would fall after the regular close' };
  return { ok: true, why: '' };
}

export function h001Eligibility(c: H001Candidate, ctx: H001Context): H001Eligibility {
  const findings: H001Finding[] = [];
  const fail = (rule: H001Rule, why: string) => findings.push({ rule, outcome: 'FAIL', why });
  const unknown = (rule: H001Rule, why: string) => findings.push({ rule, outcome: 'UNKNOWN', why });

  if (c.underlying !== H001_UNDERLYING) fail('underlying', `${c.underlying} is not ${H001_UNDERLYING}`);

  if (c.legs.length !== 1) fail('single-leg-call', `${c.legs.length} legs; the study admits single-leg signals only`);
  else if (c.legs[0]!.right !== 'C') fail('single-leg-call', 'a put signal');
  // The evidence must be one call contract too: a single-leg signal whose
  // prints span two contracts is a pipeline defect, and admitting it would let
  // the study measure something it never described.
  const contracts = new Set(c.evidence.map((e) =>
    `${e.instrument.underlying}|${e.instrument.expiry}|${e.instrument.strike}|${e.instrument.right}`));
  if (contracts.size > 1) fail('single-leg-call', `the evidence spans ${contracts.size} contracts`);
  if (c.evidence.some((e) => e.instrument.right !== 'C')) fail('single-leg-call', 'evidence includes a put print');

  // BUY_LEAN is never pooled (§I). Only a side at or through the quote counts.
  const group: H001Group | null = c.side === 'BUY' ? 'A' : c.side === 'SELL' ? 'B' : null;
  if (group === null) fail('side', `engine side ${c.side}; only BUY (A) and SELL (B) are admitted`);

  if (!(Number.isFinite(c.totalPremium) && c.totalPremium >= H001_PREMIUM_FLOOR)) {
    fail('premium', `premium ${c.totalPremium} is below $${H001_PREMIUM_FLOOR.toLocaleString('en-US')}`);
  }

  if (c.evidence.length === 0) unknown('detector-admission', 'the signal names no evidence events');
  for (const e of c.evidence) {
    const a = detectorAdmission({ kind: 'ORDERED', event: e, finalizedAt: e.availableAt, orderBasis: 'EVENT_TIME' });
    if (!a.admit) fail('detector-admission', `${e.eventId}: ${a.reason}`);

    const s = researchEligibility(e.sessionEvidence, e.eventTime, H001_V2_SESSION_RULE);
    if (s.eligibility === 'EXCLUDED') fail('session', `${e.eventId}: ${s.why}`);
    else if (s.eligibility === 'UNKNOWN') unknown('session', `${e.eventId}: ${s.why}`);

    const life = contractSessionAt(e.instrument.underlying, e.instrument.expiry, e.eventTime);
    if (life.state === 'LAST_TRADING_DAY_ENDED') fail('contract-lifecycle', `${e.eventId}: ${life.basis}`);
    else if (life.state !== 'OPEN') unknown('contract-lifecycle', `${e.eventId}: ${life.state} — ${life.basis}`);

    if (e.availableAtBasis === 'EVENT_TIME_LOWER_BOUND') {
      fail('availability-basis', `${e.eventId}: availableAt is only the event time, crediting zero latency`);
    }
    if (e.synthetic) fail('synthetic', `${e.eventId} is synthetic`);
  }

  const w = decisionWindow(c.decisionAt);
  if (w.unknown !== undefined) unknown('decision-window', w.unknown);
  else if (!w.ok) fail('decision-window', w.why);

  if (c.synthetic) fail('synthetic', 'the signal is synthetic');

  const rights = importPermitted(c.manifest, ctx.today, ctx.mode);
  if (!rights.allowed) fail('rights', rights.why.join('; '));

  if (c.finalRevision.evaluatedAt !== null) {
    unknown('final-tape', 'the revision was read from an as-known view; §J needs the FINAL_CORRECTED one');
  } else if (c.finalRevision.status !== 'FINAL') {
    fail('final-tape', `final-tape revision is ${c.finalRevision.status}: ${c.finalRevision.why}`);
  }

  const missingMarks = [!c.marks.entry && 'entry', !c.marks.exit && 'exit'].filter(Boolean);
  if (missingMarks.length > 0) fail('marks', `no ${missingMarks.join(' or ')} mark under §C's rules`);

  const verdict: H001Verdict =
    findings.some((f) => f.outcome === 'FAIL') ? 'EXCLUDED'
      : findings.length > 0 ? 'UNKNOWN'
        : 'INCLUDED';
  return { signalId: c.signalId, verdict, group: verdict === 'INCLUDED' ? group : null, findings };
}
