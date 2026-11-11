/**
 * The structure engine's parameters, and the version that names them.
 *
 * **Every number below is an untuned hypothesis, not a finding.** Each was
 * picked as a plausible default before any data existed to test it against —
 * there is no bar feed yet — and none has a measured predictive value. They are
 * named and exported so that a study can vary them deliberately, and versioned
 * so that an event computed under one set can never be pooled with an event
 * computed under another without anyone noticing.
 *
 * `STRUCTURE_METHOD_VERSION` is a hash of the rule version and every parameter.
 * Change a parameter and the version changes by construction. Change a RULE —
 * the code of a detector — and `STRUCTURE_RULES_VERSION` must be bumped by hand;
 * `structureVersion.test.ts` pins the detectors' source to that string, so a
 * definition edited without a bump fails there rather than shipping under the
 * old name.
 */
import { createHash } from 'node:crypto';

/**
 * Bump on any change to what a detector computes. `structureVersion.test.ts`
 * holds the source to this string.
 */
export const STRUCTURE_RULES_VERSION = 'structure-rules/1';

export interface StructureParams {
  /**
   * Bars strictly lower-high (or higher-low) required to the LEFT of a pivot.
   * Choice: 2. Untuned.
   */
  pivotLeft: number;
  /**
   * Bars not exceeding the pivot required to the RIGHT. A pivot is knowable
   * only at the close of the last of these, so this is also the confirmation
   * delay in bars. Choice: 2. Untuned. Must be at least 1, or a pivot would be
   * emitted at its own bar.
   */
  pivotRight: number;
  /** Bars in the true-range average a displacement is measured against. Choice: 14. Untuned. */
  atrPeriod: number;
  /** A body at least this many ATRs is a displacement. Choice: 1.5. Untuned. */
  displacementK: number;
  /**
   * Bars, counting the excursion bar itself, within which a close back inside
   * a swept level makes it a sweep-and-reclaim. Choice: 3. Untuned.
   */
  sweepReclaimBars: number;
  /**
   * Bars after formation for which a fair-value gap is tracked; one not
   * inverted by then is EXPIRED and emits nothing further. Choice: 60. Untuned.
   */
  fvgExpiryBars: number;
  /**
   * Bars by which two symbols' swing pivots may differ and still be compared
   * for SMT. Choice: 2. Untuned.
   */
  smtAlignToleranceBars: number;
}

export const DEFAULT_PARAMS: Readonly<StructureParams> = Object.freeze({
  pivotLeft: 2,
  pivotRight: 2,
  atrPeriod: 14,
  displacementK: 1.5,
  sweepReclaimBars: 3,
  fvgExpiryBars: 60,
  smtAlignToleranceBars: 2,
});

const INTEGER_KEYS = [
  'pivotLeft', 'pivotRight', 'atrPeriod', 'sweepReclaimBars', 'fvgExpiryBars',
] as const;

/**
 * Every reason a parameter set is unusable. Refusal, not repair: a pivot width
 * of 0 is not "probably 1", it is a request for a pivot emitted at its own bar.
 */
export function paramRefusals(p: StructureParams): string[] {
  const reasons: string[] = [];
  for (const k of INTEGER_KEYS) {
    if (!Number.isInteger(p[k]) || p[k] < 1) reasons.push(`${k} must be an integer of at least 1, got ${p[k]}`);
  }
  if (!Number.isInteger(p.smtAlignToleranceBars) || p.smtAlignToleranceBars < 0) {
    reasons.push(`smtAlignToleranceBars must be an integer of at least 0, got ${p.smtAlignToleranceBars}`);
  }
  if (!Number.isFinite(p.displacementK) || !(p.displacementK > 0)) {
    reasons.push(`displacementK must be a positive finite number, got ${p.displacementK}`);
  }
  const known = new Set(Object.keys(DEFAULT_PARAMS));
  for (const k of Object.keys(p)) if (!known.has(k)) reasons.push(`unknown parameter ${k}`);
  return reasons;
}

export class StructureParamsError extends Error {
  constructor(public readonly reasons: string[]) {
    super(`structure parameters refused: ${reasons.join('; ')}`);
  }
}

/** Defaults overlaid with overrides, refused rather than returned if unusable. */
export function resolveParams(overrides: Partial<StructureParams> = {}): StructureParams {
  const p: StructureParams = { ...DEFAULT_PARAMS, ...overrides };
  const reasons = paramRefusals(p);
  if (reasons.length > 0) throw new StructureParamsError(reasons);
  return p;
}

export function checkParams(p: StructureParams): void {
  const reasons = paramRefusals(p);
  if (reasons.length > 0) throw new StructureParamsError(reasons);
}

/**
 * The version of a rule set under a parameter set. Keys are sorted so the hash
 * cannot depend on the order an override object was written in.
 */
export function methodVersionFor(rulesVersion: string, p: StructureParams): string {
  const keys = Object.keys(p).sort() as (keyof StructureParams)[];
  const canonical = JSON.stringify({ rules: rulesVersion, params: keys.map((k) => [k, p[k]]) });
  return `${rulesVersion}:${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
}

export function methodVersionOf(p: StructureParams): string {
  return methodVersionFor(STRUCTURE_RULES_VERSION, p);
}

/** The version every event carries under the default parameters. */
export const STRUCTURE_METHOD_VERSION = methodVersionOf(DEFAULT_PARAMS);
