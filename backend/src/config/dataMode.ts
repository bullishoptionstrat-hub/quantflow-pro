/**
 * DATA_MODE — the provenance switch.
 *
 * live: no synthetic generator may run. Every emitted event came from a
 *       real upstream feed.
 * demo: synthetic generators may run, but every synthetic event MUST carry
 *       `synthetic: true`. There is no code path that emits an untagged
 *       synthetic event.
 *
 * Default is `demo`, because this build's default configuration (no upstream
 * API keys) produces synthetic data. Defaulting to `live` would label
 * generated data as real, which is the failure mode this switch exists to
 * prevent.
 */

export type DataMode = 'live' | 'demo';

export const DEFAULT_DATA_MODE: DataMode = 'demo';

export function resolveDataMode(env: NodeJS.ProcessEnv = process.env): DataMode {
  const raw = (env.DATA_MODE ?? '').trim().toLowerCase();
  if (raw === 'live') return 'live';
  if (raw === 'demo') return 'demo';
  return DEFAULT_DATA_MODE;
}

/** True when synthetic generators are permitted to run at all. */
export function syntheticGeneratorsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveDataMode(env) === 'demo';
}

/** Anything that can be emitted onto the flow/print/level surfaces. */
export interface SyntheticTaggable {
  synthetic?: true;
  source?: string;
}

/**
 * The single sanctioned constructor for synthetic payloads. Stamps
 * `synthetic: true` so no generator can produce an untagged record even by
 * omission.
 */
export function markSynthetic<T extends object>(value: T): T & { synthetic: true } {
  return { ...value, synthetic: true };
}

/**
 * Emission guard. Returns the reason a payload must not be emitted, or null
 * when it is safe. Two rules, both enforced at the emit boundary:
 *   1. In live mode, a synthetic payload must never be emitted.
 *   2. In any mode, an untagged payload from a synthetic source must never be
 *      emitted.
 */
export type EmissionRejection = 'synthetic_in_live_mode' | 'untagged_synthetic_source';

/**
 * Sources whose records are generated locally rather than received from an
 * upstream feed. Kept explicit so a new generator cannot quietly inherit
 * "real" provenance.
 */
export const SYNTHETIC_SOURCES: readonly string[] = ['simulation', 'seed', 'mock', 'synthetic'];

export function isSyntheticSource(source: string | undefined): boolean {
  return typeof source === 'string' && SYNTHETIC_SOURCES.includes(source);
}

export function rejectEmission(
  payload: SyntheticTaggable,
  env: NodeJS.ProcessEnv = process.env,
): EmissionRejection | null {
  const tagged = payload.synthetic === true;
  const fromSyntheticSource = isSyntheticSource(payload.source);

  if (fromSyntheticSource && !tagged) return 'untagged_synthetic_source';
  if ((tagged || fromSyntheticSource) && resolveDataMode(env) === 'live') {
    return 'synthetic_in_live_mode';
  }
  return null;
}
