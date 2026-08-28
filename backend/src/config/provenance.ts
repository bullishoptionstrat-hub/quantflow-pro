/**
 * Truth Firewall — the provenance contract every market event carries.
 *
 * Field names follow CLAUDE_CODE_MASTER_PROMPT.md verbatim. Three naming
 * schemes existed before this wave (shipped `synthetic`, specced
 * `provenance{}`/`quality_flags[]` in docs/EVENT_MODEL_V2.md, and the prompt's
 * flat list); the prompt wins. `synthetic` is retained as a DEPRECATED alias
 * for one wave so nothing downstream breaks mid-migration.
 *
 * Design rules that make the contract hard to violate:
 *   - Booleans are `true`-only optionals. Absence is the negative case, so a
 *     forgotten field can never read as an affirmative "this is real data".
 *   - `is_inferred` requires `inference_method` + `confidence`. An inference
 *     without a stated method and confidence is not emittable.
 *   - `is_delayed` requires `estimated_delay_seconds`. Delayed data may never
 *     be described as live anywhere (prompt prohibition, line 22).
 */

/** How a value came to exist. Closed union — no freeform strings. */
export type RawOrDerived = 'raw' | 'derived';

/** Confidence tier for any classifier output (prompt Wave 4 vocabulary). */
export type InferenceGrade =
  | 'OBSERVED'
  | 'STRONG_INFERENCE'
  | 'WEAK_INFERENCE'
  | 'UNKNOWN';

export type ProviderStatus = 'ok' | 'degraded' | 'stale' | 'down' | 'quota_exhausted';

/**
 * The provenance envelope. Every market event/signal carries as much of this
 * as applies. Optional fields are optional because not every source can
 * supply them — never because they are safe to omit.
 */
export interface Provenance {
  source: string;
  source_type: 'exchange' | 'broker' | 'vendor' | 'aggregator' | 'derived' | 'generator';

  /** Times. `provider_timestamp`/`exchange_timestamp` are null when the provider gives none — never substituted. */
  provider_timestamp?: string | null;
  exchange_timestamp?: string | null;
  received_at: string;
  ingested_at?: string;
  processed_at?: string;

  raw_or_derived: RawOrDerived;

  /** Generated locally rather than observed. `true`-only. */
  is_synthetic?: true;
  /** Emitted while running in demo mode. `true`-only. */
  is_demo?: true;

  /** Not realtime. Requires estimated_delay_seconds — enforced by validateProvenance. */
  is_delayed?: true;
  estimated_delay_seconds?: number;

  /** Value was inferred, not observed. Requires method + confidence. */
  is_inferred?: true;
  inference_method?: string;
  /** 0–1. */
  confidence?: number;

  /** 0–1 composite input quality. */
  quality_score?: number;

  schema_version: number;
  calculation_version?: string;
  provider_status?: ProviderStatus;
}

export const PROVENANCE_SCHEMA_VERSION = 2;

/** Anything carrying provenance, plus the deprecated flat alias. */
export interface ProvenanceCarrier {
  provenance?: Provenance;
  /** @deprecated one-wave alias for provenance.is_synthetic. Removed in W2. */
  synthetic?: true;
  source?: string;
}

export type ProvenanceViolation =
  | 'missing_provenance'
  | 'delayed_without_delay_estimate'
  | 'inferred_without_method'
  | 'inferred_without_confidence'
  | 'confidence_out_of_range'
  | 'synthetic_without_demo_flag'
  | 'demo_flag_without_synthetic';

/**
 * Structural validation. Returns every violation rather than the first, so a
 * caller sees the whole problem at once.
 */
export function validateProvenance(p: Provenance | undefined): ProvenanceViolation[] {
  if (!p) return ['missing_provenance'];
  const out: ProvenanceViolation[] = [];

  if (p.is_delayed && typeof p.estimated_delay_seconds !== 'number') {
    out.push('delayed_without_delay_estimate');
  }
  if (p.is_inferred) {
    if (!p.inference_method) out.push('inferred_without_method');
    if (typeof p.confidence !== 'number') out.push('inferred_without_confidence');
  }
  if (typeof p.confidence === 'number' && (p.confidence < 0 || p.confidence > 1)) {
    out.push('confidence_out_of_range');
  }
  // Synthetic data is only produced in demo mode, so the two flags travel
  // together. Either alone means a generator wired up its provenance wrong.
  if (p.is_synthetic && !p.is_demo) out.push('synthetic_without_demo_flag');
  if (p.is_demo && !p.is_synthetic) out.push('demo_flag_without_synthetic');

  return out;
}

/** Provenance for a locally generated record. The ONLY sanctioned way to build one. */
export function syntheticProvenance(source: string, now: () => Date = () => new Date()): Provenance {
  const ts = now().toISOString();
  return {
    source,
    source_type: 'generator',
    provider_timestamp: null,
    exchange_timestamp: null,
    received_at: ts,
    ingested_at: ts,
    raw_or_derived: 'derived',
    is_synthetic: true,
    is_demo: true,
    quality_score: 0,
    schema_version: PROVENANCE_SCHEMA_VERSION,
    provider_status: 'ok',
  };
}

/** Provenance for a record received from a real upstream feed. */
export function upstreamProvenance(
  input: {
    source: string;
    source_type?: Provenance['source_type'];
    provider_timestamp?: string | null;
    exchange_timestamp?: string | null;
    is_delayed?: true;
    estimated_delay_seconds?: number;
    provider_status?: ProviderStatus;
  },
  now: () => Date = () => new Date(),
): Provenance {
  const ts = now().toISOString();
  return {
    source: input.source,
    source_type: input.source_type ?? 'vendor',
    provider_timestamp: input.provider_timestamp ?? null,
    exchange_timestamp: input.exchange_timestamp ?? null,
    received_at: ts,
    ingested_at: ts,
    raw_or_derived: 'raw',
    ...(input.is_delayed ? { is_delayed: true as const } : {}),
    ...(typeof input.estimated_delay_seconds === 'number'
      ? { estimated_delay_seconds: input.estimated_delay_seconds }
      : {}),
    schema_version: PROVENANCE_SCHEMA_VERSION,
    provider_status: input.provider_status ?? 'ok',
  };
}

/**
 * The UI badge a record must render. Order is deliberate: the most
 * trust-reducing fact wins, so a demo event is never shown as merely DELAYED.
 */
export type ProvenanceBadge = 'DEMO' | 'DELAYED' | 'INFERRED' | 'LIVE';

export function badgeFor(p: Provenance | undefined): ProvenanceBadge {
  // No provenance is not evidence of good provenance — treat as DEMO (lowest trust).
  if (!p) return 'DEMO';
  if (p.is_synthetic || p.is_demo) return 'DEMO';
  // Defense in depth: source_type alone is enough to disqualify a record from
  // ever rendering as real, even if the boolean flags were stripped.
  if (p.source_type === 'generator') return 'DEMO';
  if (p.is_delayed) return 'DELAYED';
  if (p.is_inferred) return 'INFERRED';
  return 'LIVE';
}

/** Single-line log form. Never includes secrets — only provenance facts. */
export function provenanceLogLine(p: Provenance | undefined): string {
  if (!p) return 'provenance=MISSING';
  const parts = [
    `source=${p.source}`,
    `badge=${badgeFor(p)}`,
    `raw_or_derived=${p.raw_or_derived}`,
  ];
  if (p.is_synthetic) parts.push('is_synthetic=true');
  if (p.is_demo) parts.push('is_demo=true');
  if (p.is_delayed) parts.push(`is_delayed=true delay_s=${p.estimated_delay_seconds}`);
  if (p.is_inferred) parts.push(`is_inferred=true method=${p.inference_method} conf=${p.confidence}`);
  if (p.provider_status && p.provider_status !== 'ok') parts.push(`provider_status=${p.provider_status}`);
  return parts.join(' ');
}
