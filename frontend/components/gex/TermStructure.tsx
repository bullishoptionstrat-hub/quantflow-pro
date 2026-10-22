'use client'
import { useEffect, useState } from 'react'
import { useStore } from '@/store/useStore'
import { loadPanel, type Panel } from '@/lib/panel'
import type { VolResponse } from '@/lib/types'

/**
 * ROADMAP 5.4 — the ATM implied-volatility term structure, and IV rank /
 * percentile refused with the reason the backend gives.
 *
 * Three rules, inherited from the payload rather than decided here:
 *
 *   - **IVs are rendered as percentages, and the conversion happens once.**
 *     Cboe's per-contract `iv` is a fraction and its `iv30` is a percentage
 *     (`ivUnits: 'FRACTION'`, `iv30Units: 'PERCENT'`, read off a captured
 *     chain, not assumed). The fraction is multiplied by 100 here and nowhere
 *     else; `iv30` is shown as it came. Until that chain was captured this
 *     panel rendered the raw numbers with no `%`, because multiplying would
 *     have been a guess wrong by two orders of magnitude half the time.
 *   - **IV rank and percentile say "not reported" and why.** They need a year
 *     of stored history, and the chain is not persistable here. A rank over
 *     whatever survived since boot would be a percentile of an afternoon.
 *   - **ATM is shown with its distance from spot.** On a sparse expiry the
 *     nearest strike with both sides quoted can be far from the money; the
 *     column makes that visible instead of hiding it behind the label.
 */

const mono = "'JetBrains Mono', monospace"
const muted: React.CSSProperties = { fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }

/** A per-contract IV, published as a fraction, shown as a percentage to two places. */
export function ivPct(v: number | null): string {
  return v == null ? '—' : `${(v * 100).toFixed(2)}%`
}

/** Cboe's iv30, published already as a percentage, shown to two places. */
export function iv30Pct(v: number | null): string {
  return v == null ? '—' : `${v.toFixed(2)}%`
}

export function TermStructurePanel({ panel, symbol }: { panel: Panel<VolResponse>; symbol: string }) {
  if (panel.status !== 'ok') {
    const text = panel.status === 'loading'
      ? 'Loading the volatility curve…'
      : panel.status === 'unauthorized'
        ? 'The backend refused this session for the volatility curve.'
        : 'The backend did not answer for the volatility curve.'
    return <div className="card" style={{ padding: 20, textAlign: 'center', ...muted }}>{text}</div>
  }
  const v = panel.data
  const points = v.termStructure?.points ?? []

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>IMPLIED VOLATILITY — {symbol}</span>
        {v.source && (
          <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: mono }}>
            {String(v.source).toUpperCase()} · {v.delayedMinutes ?? '?'}MIN DELAYED · trade date {v.tradeDate ?? '—'}
          </span>
        )}
      </div>

      <div style={{ padding: '12px 16px', display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 12, fontFamily: mono }}>
        <span>IV30: <strong>{iv30Pct(v.iv30)}</strong></span>
        <span data-testid="iv-rank">
          IV RANK / PERCENTILE: <strong style={{ color: '#fde68a' }}>NOT REPORTED</strong>
        </span>
      </div>
      <div style={{ ...muted, padding: '0 16px 10px' }}>{v.ivRankUnavailable}</div>

      {!v.realData || points.length === 0 ? (
        <div style={{ ...muted, padding: '16px', textAlign: 'center' }}>
          {v.unavailableReason ?? 'No term structure in the chain.'} Nothing is drawn rather than something guessed.
        </div>
      ) : (
        <>
          <table className="flow-table">
            <thead>
              <tr>
                <th>EXPIRY</th><th>DTE</th><th>ATM STRIKE</th><th>FROM SPOT</th>
                <th>CALL IV</th><th>PUT IV</th><th>ATM IV</th><th>NO IV</th>
              </tr>
            </thead>
            <tbody>
              {points.map((t) => (
                <tr key={t.expiry}>
                  <td style={{ fontFamily: mono }}>{t.expiry}</td>
                  <td style={{ fontFamily: mono }}>{t.dte ?? '—'}</td>
                  <td style={{ fontFamily: mono }}>{t.atmStrike ?? '—'}</td>
                  <td style={{ fontFamily: mono, color: 'var(--text-muted)' }}>
                    {t.distancePct == null ? '—' : `${t.distancePct >= 0 ? '+' : ''}${(t.distancePct * 100).toFixed(1)}%`}
                  </td>
                  <td style={{ fontFamily: mono }}>{ivPct(t.callIv)}</td>
                  <td style={{ fontFamily: mono }}>{ivPct(t.putIv)}</td>
                  <td style={{ fontFamily: mono, fontWeight: 700 }}>{ivPct(t.atmIv)}</td>
                  <td style={{ fontFamily: mono, color: t.ivMissing > 0 ? '#fde68a' : 'var(--text-muted)' }}>
                    {t.ivMissing} / {t.contracts}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* Verbatim: the basis and the units travel with the numbers. */}
          <div style={{ ...muted, padding: '10px 16px 14px' }} data-testid="iv-basis">
            {v.termStructure?.basis} Published units: per-contract {v.termStructure?.ivUnits}, iv30 {v.termStructure?.iv30Units}; shown as percentages.
          </div>
        </>
      )}
    </div>
  )
}

/** The panel, following the ticker the GEX chart has selected. */
export function TermStructure() {
  const { selectedTicker } = useStore()
  const [panel, setPanel] = useState<Panel<VolResponse>>({ status: 'loading' })

  useEffect(() => {
    let live = true
    setPanel({ status: 'loading' })
    const read = () => loadPanel(`/api/gex/vol?symbol=${encodeURIComponent(selectedTicker)}`, (b) => b as VolResponse)
      .then((p) => { if (live) setPanel(p) })
    void read()
    // Same cadence as the GEX chart: the chain is 15 minutes delayed.
    const t = setInterval(() => void read(), 60_000)
    return () => { live = false; clearInterval(t) }
  }, [selectedTicker])

  return <TermStructurePanel panel={panel} symbol={selectedTicker} />
}
