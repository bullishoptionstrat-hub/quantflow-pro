/**
 * The setup engine's parameters, and the version that names them.
 *
 * **Every number below is an untuned hypothesis, not a finding.** None has been
 * measured against data — there is no bar feed, and imported files have not
 * been studied — and none should be read as evidence of an edge. They are
 * named so a study can vary them deliberately, and versioned so an idea
 * evaluated under one set is never pooled with one evaluated under another.
 *
 * `SETUP_METHOD_VERSION` hashes the setup rules version, these parameters and
 * `STRUCTURE_METHOD_VERSION`, because a setup is built on structure events and
 * a change to either changes what the setup means.
 */
import { createHash } from 'node:crypto';
import { STRUCTURE_METHOD_VERSION } from '../structure/params';

/** Bump on any change to what the state machine decides. */
export const SETUP_RULES_VERSION = 'setup-rules/1';

export interface SetupParams {
  /** Series bars after the sweep within which a displacement must be known. Choice: 5. Untuned. */
  displacementWindowBars: number;
  /** Series bars after the sweep within which the trigger must close, or the idea EXPIRES. Choice: 30. Untuned. */
  expiryBars: number;
  /** An SMT divergence known more than this many minutes before the sweep is stale. Choice: 30. Untuned. */
  smtMaxAgeMinutes: number;
  /** Minimum reward-to-risk, NET of the supplied costs. Choice: 2. Untuned (the playbook's stated floor). */
  minNetR: number;
  /** A dealing range narrower than this fraction of its EQ is compression. Choice: 0.002. Untuned. */
  minRangeFraction: number;
}

export const DEFAULT_SETUP_PARAMS: Readonly<SetupParams> = Object.freeze({
  displacementWindowBars: 5,
  expiryBars: 30,
  smtMaxAgeMinutes: 30,
  minNetR: 2,
  minRangeFraction: 0.002,
});

export function setupParamRefusals(p: SetupParams): string[] {
  const reasons: string[] = [];
  for (const k of ['displacementWindowBars', 'expiryBars', 'smtMaxAgeMinutes'] as const) {
    if (!Number.isInteger(p[k]) || p[k] < 1) reasons.push(`${k} must be an integer of at least 1, got ${p[k]}`);
  }
  if (!(Number.isFinite(p.minNetR) && p.minNetR >= 2)) reasons.push(`minNetR must be a finite number of at least 2, got ${p.minNetR}`);
  if (!(Number.isFinite(p.minRangeFraction) && p.minRangeFraction > 0)) reasons.push(`minRangeFraction must be positive, got ${p.minRangeFraction}`);
  const known = new Set(Object.keys(DEFAULT_SETUP_PARAMS));
  for (const k of Object.keys(p)) if (!known.has(k)) reasons.push(`unknown parameter ${k}`);
  return reasons;
}

export function setupMethodVersionOf(p: SetupParams, structureVersion: string = STRUCTURE_METHOD_VERSION): string {
  const keys = Object.keys(p).sort() as (keyof SetupParams)[];
  const canonical = JSON.stringify({ rules: SETUP_RULES_VERSION, structure: structureVersion, params: keys.map((k) => [k, p[k]]) });
  return `${SETUP_RULES_VERSION}:${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
}

export const SETUP_METHOD_VERSION = setupMethodVersionOf(DEFAULT_SETUP_PARAMS);
