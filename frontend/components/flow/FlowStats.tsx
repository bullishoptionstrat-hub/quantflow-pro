'use client'
import { useStore } from '@/store/useStore'
import { formatPremium } from '@/lib/utils'

/**
 * Six tiles that said TOTAL and meant "the last few hundred signals".
 *
 * `flowEvents` is a client-side ring buffer capped at 500, filled only from
 * the moment this page mounted — and until now it was also **pre-filtered at
 * ingest**, so the tiles summed whatever had happened to match the filters in
 * force as each signal arrived. `TOTAL PREMIUM` and `TOTAL TRADES` read as the
 * session's, and `TOTAL TRADES` pins at exactly 500 on a busy tape and stays
 * there. The backend's own buffer caps at 500 too, so `/api/flow/stats` would
 * not have made the word true either.
 *
 * Two further defects in six tiles:
 *
 *   - `P/C RATIO` was `putPremium / callPremium`, a **premium** ratio, sharing
 *     its name with `/api/flow/stats`'s `callPutRatio` (a **count** ratio, and
 *     the other way up) and with the macro page's Cboe put/call, which is
 *     exchange volume. Three quantities, one label.
 *   - With puts and no calls — the most bearish tape there is — the tile fell
 *     to `'—'`, and `Number('—') > 1` is false, so it was coloured **green**.
 *
 * Simulated prints were pooled in silently. The feed marks them per row, and
 * the demo banner is all-or-nothing; neither covers a credentialed deployment
 * where some rows are observed tape and some are constructed from aggregate
 * volume. An aggregate that mixes them has to say how many.
 */

/** Matches `MAX_FLOW_EVENTS` in the backend's ingestion buffer. */
const WINDOW_CAP = 500

/** `4m 12s`, for saying how much tape a window covers. */
function spanOf(events: { created_at: string }[]): string | null {
  if (events.length < 2) return null
  const times = events.map(e => new Date(e.created_at).getTime()).filter(Number.isFinite)
  if (times.length < 2) return null
  const secs = Math.round((Math.max(...times) - Math.min(...times)) / 1000)
  if (secs < 60) return `${secs}s`
  const m = Math.floor(secs / 60)
  if (m < 60) return `${m}m ${secs % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function FlowStats() {
  const { flowEvents } = useStore()

  const calls = flowEvents.filter(e => e.option_type === 'C')
  const puts = flowEvents.filter(e => e.option_type === 'P')
  const sweeps = flowEvents.filter(e => e.order_type === 'SWEEP')
  const synthetic = flowEvents.filter(e => e.synthetic)
  const callPrem = calls.reduce((s, e) => s + e.total_premium, 0)
  const putPrem = puts.reduce((s, e) => s + e.total_premium, 0)

  // `null` where there is nothing to divide by, rather than a dash that reads
  // as a number to the colour logic.
  const putCallPrem = callPrem > 0 ? putPrem / callPrem : null

  const span = spanOf(flowEvents)

  const stats = [
    { label: 'PREMIUM', value: formatPremium(callPrem + putPrem), color: '#fafafa' },
    { label: 'CALL PREMIUM', value: formatPremium(callPrem), color: '#22c55e' },
    { label: 'PUT PREMIUM', value: formatPremium(putPrem), color: '#ef4444' },
    {
      // Named for its direction *and* its basis, so it cannot be read as the
      // Cboe volume ratio on the macro page or as the backend's count ratio.
      label: 'PUT/CALL $',
      value: putCallPrem === null ? '—' : putCallPrem.toFixed(2),
      color: putCallPrem === null ? 'var(--text-muted)' : putCallPrem > 1 ? '#ef4444' : '#22c55e',
    },
    { label: 'SWEEPS', value: sweeps.length.toString(), color: '#a78bfa' },
    { label: 'SIGNALS', value: flowEvents.length.toString(), color: '#fbbf24' },
  ]

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8 }}>
        {stats.map(s => (
          <div key={s.label} className="card" style={{ padding: '12px 14px' }}>
            <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 6, fontFamily: "'Inter', sans-serif" }}>{s.label}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: s.color, fontFamily: "'JetBrains Mono', monospace" }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* What the six numbers are actually over. Every one of them is a
          window, not a session, and the window has an edge worth stating. */}
      <div style={{ marginTop: 6, fontSize: 10, color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace", display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <span>
          {flowEvents.length === 0
            ? 'no signals received this session'
            : `over the ${flowEvents.length} signals received this session${span ? `, spanning ${span}` : ''}`}
        </span>
        {flowEvents.length >= WINDOW_CAP && (
          <span style={{ color: '#fbbf24' }}>· window full at {WINDOW_CAP} — older signals have dropped off</span>
        )}
        {synthetic.length > 0 && (
          <span style={{ color: '#fbbf24' }}>· {synthetic.length} simulated</span>
        )}
      </div>
    </div>
  )
}
