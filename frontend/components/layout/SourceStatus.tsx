import Link from 'next/link'
import type { Panel } from '@/lib/panel'
import type { SourceState, SourceSummary } from '@/lib/sourceSummary'

/**
 * Source counts in the backend's own states, linking to Settings for detail.
 * Green only for `connected` with no note; nothing is green while the state
 * is unknown. See `lib/sourceSummary.ts` for why the labels are not "LIVE".
 */
const STYLE: Record<SourceState, { label: string; fg: string; bg: string }> = {
  connected: { label: 'CONNECTED', fg: '#86efac', bg: 'rgba(34,197,94,0.1)' },
  degraded:  { label: 'DEGRADED',  fg: '#fde68a', bg: 'rgba(251,191,36,0.12)' },
  error:     { label: 'ERROR',     fg: '#fca5a5', bg: 'rgba(248,113,113,0.12)' },
  refused:   { label: 'REFUSED',   fg: '#d4d4d8', bg: 'rgba(161,161,170,0.12)' },
  disabled:  { label: 'OFF',       fg: '#a1a1aa', bg: 'rgba(161,161,170,0.08)' },
  unknown:   { label: 'UNKNOWN',   fg: '#a1a1aa', bg: 'rgba(161,161,170,0.08)' },
}
const ORDER: SourceState[] = ['connected', 'degraded', 'error', 'refused', 'disabled', 'unknown']
const chip = { fontSize: 8, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, borderRadius: 2, padding: '1px 4px' } as const

function note(text: string) {
  return <span style={{ ...chip, color: '#a1a1aa', background: 'rgba(161,161,170,0.08)' }}>{text}</span>
}

export function SourceStatus({ panel }: { panel: Panel<SourceSummary | null> }) {
  let body: React.ReactNode
  if (panel.status === 'loading') body = null
  else if (panel.status === 'unreachable') body = note('SOURCES: BACKEND UNREACHABLE')
  else if (panel.status === 'unauthorized') body = note('SOURCES: NOT AUTHORIZED')
  else if (panel.data == null) body = note('SOURCES: NOT REPORTED')
  else {
    const s = panel.data
    body = (
      <>
        {ORDER.filter((k) => s.byState[k].length > 0).map((k) => (
          <span key={k} title={s.byState[k].join(', ')} style={{ ...chip, color: STYLE[k].fg, background: STYLE[k].bg }}>
            {s.byState[k].length} {STYLE[k].label}
          </span>
        ))}
        {s.simulation && (
          <span title="The backend is generating simulated prints. They are labelled per row and never enter the track record."
            style={{ ...chip, color: '#c4b5fd', background: 'rgba(139,92,246,0.15)' }}>
            SIMULATOR ON
          </span>
        )}
      </>
    )
  }
  return (
    <Link href="/settings" aria-label="Data source status — open Settings for detail"
      style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8, textDecoration: 'none', minHeight: 12 }}>
      {body}
    </Link>
  )
}
