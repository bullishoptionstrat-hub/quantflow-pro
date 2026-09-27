/**
 * RESEARCH SESSION ELIGIBILITY — does this event belong in a study's sample?
 *
 * The last of the four session questions, and the one most easily confused
 * with the others. An extended-hours trade is a real OPRA event; it may be a
 * contract that was genuinely tradable; and it is still outside a study that
 * preregistered regular hours. "The event occurred" and "the event belongs in
 * this experiment" are different facts (INV-SESSION-002).
 *
 * Provider evidence outranks the clock (INV-SESSION-003). A clock is consulted
 * only when the provider said nothing about the session at all, and only if
 * the study's rule allows it — and then only to say REGULAR inside the
 * exchange's published regular hours, where no extended session runs.
 *
 * `UNKNOWN` is not `EXCLUDED`. Both keep an event out of a sample, but a
 * conflict or an unreadable identifier is a data question someone can answer,
 * while an extended-hours print is correctly out. Counting them together would
 * hide how much of a sample was lost to evidence problems.
 */
import type { SessionEvidence } from '../events/types';
import { inferSessionFromClock } from '../events/session';

export type ResearchSessionEligibility = 'INCLUDED' | 'EXCLUDED' | 'UNKNOWN';

export interface ResearchSessionRule {
  id: string;
  admits: 'REGULAR';
  clockInference: 'INSIDE_EXCHANGE_RTH_ONLY' | 'NEVER';
}

/** Frozen by research/hypotheses/H-001-v2-*.md. Changing it is a new hypothesis version. */
export const H001_V2_SESSION_RULE: ResearchSessionRule = Object.freeze({
  id: 'H-001-v2/session',
  admits: 'REGULAR',
  clockInference: 'INSIDE_EXCHANGE_RTH_ONLY',
});

export interface EligibilityVerdict {
  eligibility: ResearchSessionEligibility;
  basis: 'PROVIDER_EVIDENCE' | 'CLOCK_INFERENCE' | 'NONE';
  rule: string;
  why: string;
}

export function researchEligibility(
  evidence: SessionEvidence,
  eventTime: number,
  rule: ResearchSessionRule,
): EligibilityVerdict {
  const v = (eligibility: ResearchSessionEligibility, basis: EligibilityVerdict['basis'], why: string) =>
    ({ eligibility, basis, rule: rule.id, why });

  switch (evidence.normalized) {
    case 'REGULAR':
      return v('INCLUDED', 'PROVIDER_EVIDENCE', `provider evidence (${evidence.basis}) says regular session`);
    case 'EXTENDED':
      return v('EXCLUDED', 'PROVIDER_EVIDENCE', `provider evidence (${evidence.basis}) says extended hours`);
    case 'CONFLICT':
      return v('UNKNOWN', 'PROVIDER_EVIDENCE', 'the session identifier and the sale condition disagree');
    case 'UNKNOWN':
      break;
  }
  if (evidence.basis !== 'NONE') {
    // The provider sent a session field this reader could not interpret. The
    // clock does not get to overrule a field that was present.
    return v('UNKNOWN', 'PROVIDER_EVIDENCE', 'the provider sent a session identifier that could not be read');
  }
  if (rule.clockInference === 'NEVER') {
    return v('UNKNOWN', 'NONE', 'no session evidence, and this rule does not infer one from the clock');
  }
  const guess = inferSessionFromClock(eventTime);
  return guess.normalized === 'REGULAR'
    ? v('INCLUDED', 'CLOCK_INFERENCE', `no session evidence; ${guess.why}`)
    : v('UNKNOWN', 'CLOCK_INFERENCE', `no session evidence; ${guess.why}`);
}
