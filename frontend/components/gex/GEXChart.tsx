'use client'
import { useEffect, useMemo, useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer, Cell } from 'recharts'
import { useStore } from '@/store/useStore'
import { apiFetch } from '@/lib/apiFetch'
import { formatNumber } from '@/lib/utils'
import type { GEXResponse, GEXLevel } from '@/lib/types'

/**
 * Dealer gamma exposure, from the chain the backend actually has.
 *
 * This used to draw a curve it invented. With no flow events for the selected
 * ticker it produced twelve strikes of `Math.random()` — including
 * `level_type: Math.random() > 0.5 ? 'SUPPORT' : 'RESISTANCE'`, deciding by
 * coin flip whether a strike was support or resistance. With flow events it
 * did something subtler but no better: it aggregated open interest off
 * whichever individual prints happened to arrive and multiplied by a gamma of
 * `Math.abs(e.delta * 0.01) || 0.005`. Neither is gamma exposure. Both were
 * drawn in the same colours, under the same heading, beside a spot price
 * hardcoded to 2024 values.
 *
 * `/api/gex?symbol=` has been returning the real thing the whole time: 445
 * strikes for SPY with per-side open interest and gamma from Cboe's delayed
 * chain, a computed `flipStrike`, and the max/min GEX levels. The route's own
 * comment says why it reports `source` and `realData` — "The UI must be able
 * to tell them apart — a fabricated gamma flip looks exactly like a real one."
 * It could not. Now it does, and when the backend says `realData: false` this
 * draws nothing rather than something.
 *
 * Provenance is on the chart because the underlying dataset is
 * `CBOE_CDN_DELAYED_CHAIN`, which the rights registry classifies UNVERIFIED
 * for display — running but with an open question against it.
 */

/** Strikes drawn either side of the centre. 445 of them is not a chart. */
const WINDOW = 20

export function GEXChart() {
  const { selectedTicker, setSelectedTicker } = useStore()
  const tickers = ['SPX', 'SPY', 'QQQ', 'NDX', 'AAPL', 'TSLA', 'NVDA', 'MSFT']

  const [gex, setGex] = useState<GEXResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    async function load() {
      try {
        const res = await apiFetch(`/api/gex?symbol=${encodeURIComponent(selectedTicker)}`)
        if (!res.ok) throw new Error(`backend returned ${res.status}`)
        const body: GEXResponse = await res.json()
        if (cancelled) return
        setGex(body)
        setError(null)
      } catch (e: any) {
        if (cancelled) return
        setGex(null)
        setError(e?.message ?? 'could not reach the backend')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    // The chain is 15 minutes delayed; polling faster would only redraw.
    const t = setInterval(load, 60_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [selectedTicker])

  /**
   * A window of strikes centred on the gamma flip, or on the largest exposure
   * when there is no flip. Charting all 445 renders an unreadable smear, and
   * picking the largest-|gex| strikes instead would reorder the x-axis — the
   * strikes either side of the flip are the ones the panel is about anyway.
   */
  const shown: GEXLevel[] = useMemo(() => {
    const levels = gex?.levels ?? []
    if (levels.length === 0) return []
    const sorted = [...levels].sort((a, b) => a.strike - b.strike)

    let centre = sorted.findIndex((l) => l.strike === gex?.flipStrike)
    if (centre < 0) {
      let best = 0
      sorted.forEach((l, i) => { if (Math.abs(l.gex) > Math.abs(sorted[best]!.gex)) best = i })
      centre = best
    }
    return sorted.slice(Math.max(0, centre - WINDOW), centre + WINDOW + 1)
  }, [gex])

  const keyRows = useMemo(
    () => [...(gex?.levels ?? [])].sort((a, b) => Math.abs(b.gex) - Math.abs(a.gex)).slice(0, 8),
    [gex],
  )

  const Tip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null
    const d: GEXLevel | undefined = payload[0]?.payload
    if (!d) return null
    return (
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-light)', borderRadius: 6, padding: '10px 14px', fontSize: 12, fontFamily: "'JetBrains Mono', monospace" }}>
        <div style={{ color: '#a78bfa', fontWeight: 700, marginBottom: 6 }}>STRIKE ${label}</div>
        <div style={{ color: d.gex >= 0 ? '#22c55e' : '#ef4444' }}>
          NET GEX: {d.gex >= 0 ? '+' : ''}{formatNumber(Math.round(d.gex / 1e6 * 10) / 10)}M
        </div>
        {/* Open interest and gamma are what the exposure was computed from —
            shown so a reader can check the number rather than trust it. */}
        <div style={{ color: '#86efac' }}>CALL OI: {d.callOI.toLocaleString()} · γ {d.callGamma.toFixed(4)}</div>
        <div style={{ color: '#fca5a5' }}>PUT OI: {d.putOI.toLocaleString()} · γ {d.putGamma.toFixed(4)}</div>
      </div>
    )
  }

  const unavailable = !loading && (error !== null || gex === null || gex.realData === false || shown.length === 0)

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {tickers.map(t => (
          <button key={t} onClick={() => setSelectedTicker(t)} style={{
            padding: '5px 14px', borderRadius: 5,
            border: `1px solid ${selectedTicker === t ? 'rgba(139,92,246,0.5)' : 'var(--border)'}`,
            background: selectedTicker === t ? 'rgba(139,92,246,0.15)' : 'var(--bg-secondary)',
            color: selectedTicker === t ? '#a78bfa' : 'var(--text-secondary)',
            fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: "'JetBrains Mono', monospace",
          }}>{t}</button>
        ))}
        {/* Provenance, not decoration: a delayed Cboe chain and the synthetic
            fallback produce identically shaped charts. */}
        {gex && (
          <span style={{ fontSize: 10, marginLeft: 4, padding: '2px 8px', borderRadius: 4, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700,
            background: gex.realData ? 'rgba(34,197,94,0.12)' : 'rgba(251,191,36,0.12)',
            color: gex.realData ? '#86efac' : '#fde68a' }}>
            {gex.realData
              ? `${String(gex.source).toUpperCase()} · ${gex.delayedMinutes ?? '?'}MIN DELAYED`
              : 'NO REAL CHAIN'}
          </span>
        )}
      </div>

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ marginBottom: 12 }}>
          <span style={{ fontWeight: 700, color: '#fafafa', fontSize: 13 }}>NET DEALER GAMMA EXPOSURE — {selectedTicker}</span>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
            Positive = dealers long gamma (stabilizing) · Negative = dealers short gamma (volatile)
            {gex?.flipStrike != null && <> · flip at <strong style={{ color: '#fbbf24' }}>${gex.flipStrike.toLocaleString()}</strong></>}
          </div>
        </div>

        {loading ? (
          <div style={{ height: 320, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
            Loading chain…
          </div>
        ) : unavailable ? (
          <div style={{ height: 320, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, color: 'var(--text-muted)', textAlign: 'center', padding: '0 24px' }}>
            <div style={{ fontSize: 12, fontWeight: 600 }}>No gamma exposure available for {selectedTicker}</div>
            <div style={{ fontSize: 11, lineHeight: 1.6, maxWidth: 460 }}>
              {error
                ? `The backend did not answer — ${error}.`
                : gex && !gex.realData
                  ? 'The backend has no real options chain for this symbol, so there is nothing to compute dealer gamma from. It is not drawn rather than drawn from a guess.'
                  : 'The chain has not loaded yet.'}
            </div>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={shown} margin={{ top: 10, right: 20, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
              <XAxis dataKey="strike" tick={{ fill: '#71717a', fontSize: 11, fontFamily: 'JetBrains Mono' }} tickFormatter={v => `$${v}`} />
              <YAxis tick={{ fill: '#71717a', fontSize: 11, fontFamily: 'JetBrains Mono' }} tickFormatter={v => `${(v / 1e6).toFixed(0)}M`} />
              <Tooltip content={<Tip />} />
              <ReferenceLine y={0} stroke="#52525b" strokeWidth={1.5} />
              {/* The backend's flip, not one re-derived here from a windowed slice. */}
              {gex?.flipStrike != null && (
                <ReferenceLine x={gex.flipStrike} stroke="#fbbf24" strokeDasharray="4 4" strokeWidth={1.5}
                  label={{ value: 'FLIP', fill: '#fbbf24', fontSize: 10 }} />
              )}
              <Bar dataKey="gex" radius={[2, 2, 0, 0]}>
                {shown.map((l, i) => (
                  <Cell key={i} fill={l.gex >= 0 ? '#22c55e' : '#ef4444'} fillOpacity={0.8} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="card">
        <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 700, fontSize: 13 }}>LARGEST GAMMA EXPOSURE</span>
          {gex && (
            <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>
              {gex.levels.length} strikes · {new Date(gex.updatedAt).toLocaleTimeString()}
            </span>
          )}
        </div>
        {keyRows.length === 0 ? (
          <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
            Nothing to rank without a chain.
          </div>
        ) : (
          <table className="flow-table">
            <thead>
              <tr><th>STRIKE</th><th>NET GEX</th><th>CALL OI</th><th>PUT OI</th><th>NOTE</th></tr>
            </thead>
            <tbody>
              {keyRows.map(l => (
                <tr key={l.strike}>
                  <td style={{ fontWeight: 700, color: '#a78bfa' }}>${l.strike.toLocaleString()}</td>
                  <td style={{ color: l.gex >= 0 ? '#22c55e' : '#ef4444', fontWeight: 700 }}>
                    {l.gex >= 0 ? '+' : ''}{(l.gex / 1e6).toFixed(2)}M
                  </td>
                  <td style={{ color: '#86efac' }}>{l.callOI.toLocaleString()}</td>
                  <td style={{ color: '#fca5a5' }}>{l.putOI.toLocaleString()}</td>
                  <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {/* Says what the number is, not what it predicts. The old
                        column asserted SUPPORT or RESISTANCE from a coin flip. */}
                    {l.strike === gex?.flipStrike ? <span style={{ color: '#fbbf24', fontWeight: 700 }}>GAMMA FLIP</span>
                      : l.strike === gex?.keyLevels.maxGEXStrike ? 'largest positive'
                      : l.strike === gex?.keyLevels.minGEXStrike ? 'largest negative'
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
