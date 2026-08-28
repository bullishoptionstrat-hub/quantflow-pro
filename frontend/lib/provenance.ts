/**
 * Frontend mirror of the backend Truth Firewall contract
 * (backend/src/config/provenance.ts). Kept as a thin, dependency-free module
 * so any component can decide what badge to render without importing backend
 * code across the package boundary.
 */

export type ProvenanceBadge = 'DEMO' | 'DELAYED' | 'INFERRED' | 'LIVE'

export interface Provenance {
  source: string
  source_type?: string
  provider_timestamp?: string | null
  exchange_timestamp?: string | null
  received_at?: string
  raw_or_derived?: 'raw' | 'derived'
  is_synthetic?: true
  is_demo?: true
  is_delayed?: true
  estimated_delay_seconds?: number
  is_inferred?: true
  inference_method?: string
  confidence?: number
  quality_score?: number
  schema_version?: number
  provider_status?: string
}

/** Anything renderable that may carry provenance. */
export interface ProvenanceCarrier {
  provenance?: Provenance
  /** @deprecated backend one-wave alias */
  synthetic?: true
  source?: string
}

/**
 * Which badge a record must render.
 *
 * Order matters: the most trust-reducing fact wins, so a demo event is never
 * shown as merely DELAYED. Absent provenance is treated as DEMO — absence of
 * evidence must never render as evidence of liveness.
 */
export function badgeFor(carrier: ProvenanceCarrier | null | undefined): ProvenanceBadge {
  if (!carrier) return 'DEMO'
  const p = carrier.provenance
  if (carrier.synthetic === true) return 'DEMO'
  if (!p) return 'DEMO'
  if (p.is_synthetic || p.is_demo) return 'DEMO'
  if (p.is_delayed) return 'DELAYED'
  if (p.is_inferred) return 'INFERRED'
  return 'LIVE'
}

/** True when this record must not be presented as real market data. */
export function isSynthetic(carrier: ProvenanceCarrier | null | undefined): boolean {
  return badgeFor(carrier) === 'DEMO'
}

export const BADGE_COPY: Record<ProvenanceBadge, { label: string; title: string; color: string; bg: string }> = {
  DEMO: {
    label: 'DEMO',
    title: 'Generated sample data — not real market activity. Do not trade on this.',
    color: '#f59e0b',
    bg: 'rgba(245,158,11,0.14)',
  },
  DELAYED: {
    label: 'DELAYED',
    title: 'Delayed market data. Not realtime.',
    color: '#38bdf8',
    bg: 'rgba(56,189,248,0.14)',
  },
  INFERRED: {
    label: 'INFERRED',
    title: 'Derived by inference, not directly observed. See method and confidence.',
    color: '#a78bfa',
    bg: 'rgba(167,139,250,0.14)',
  },
  LIVE: {
    label: 'LIVE',
    title: 'Observed from a realtime upstream feed.',
    color: '#22c55e',
    bg: 'rgba(34,197,94,0.14)',
  },
}

/** Human-readable delay, e.g. "delayed ~15m". Never rendered as "live". */
export function delayLabel(p: Provenance | undefined): string | null {
  if (!p?.is_delayed) return null
  const s = p.estimated_delay_seconds
  if (typeof s !== 'number') return 'delayed (unknown lag)'
  if (s >= 3600) return `delayed ~${Math.round(s / 3600)}h`
  if (s >= 60) return `delayed ~${Math.round(s / 60)}m`
  return `delayed ~${s}s`
}
