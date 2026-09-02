'use client'
import { BADGE_COPY, badgeFor, delayLabel, type ProvenanceCarrier } from '@/lib/provenance'

/**
 * The visible provenance badge. Every surface rendering market data must show
 * one — a feature that cannot show its own provenance is not done.
 */
export function ProvenanceBadge({
  carrier,
  showDelay = true,
}: {
  carrier: ProvenanceCarrier | null | undefined
  showDelay?: boolean
}) {
  const badge = badgeFor(carrier)
  const copy = BADGE_COPY[badge]
  const delay = showDelay ? delayLabel(carrier?.provenance) : null

  return (
    <span
      data-testid="provenance-badge"
      data-badge={badge}
      title={copy.title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontSize: 9, fontWeight: 700, letterSpacing: '0.06em',
        fontFamily: "'JetBrains Mono', monospace",
        color: copy.color, background: copy.bg,
        border: `1px solid ${copy.color}33`,
        borderRadius: 3, padding: '1px 5px', whiteSpace: 'nowrap',
      }}
    >
      {copy.label}
      {delay ? <span style={{ opacity: 0.75, fontWeight: 500 }}>· {delay}</span> : null}
    </span>
  )
}

/**
 * Page-level banner shown whenever the backend reports demo mode. Deliberately
 * loud and not dismissible: the whole screen is fabricated data.
 */
export function DemoModeBanner({ dataMode }: { dataMode: string | null | undefined }) {
  if (dataMode !== 'demo') return null
  return (
    <div
      data-testid="demo-mode-banner"
      role="status"
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.35)',
        color: '#fbbf24', borderRadius: 6, padding: '8px 12px', marginBottom: 14,
        fontSize: 12, fontFamily: "'JetBrains Mono', monospace",
      }}
    >
      <span style={{ fontWeight: 700 }}>DEMO MODE</span>
      <span style={{ color: '#fcd34d' }}>
        Every event on this screen is generated sample data, not real market activity. Do not trade on it.
      </span>
    </div>
  )
}
