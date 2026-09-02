'use client'
import { useMemo } from 'react'
import { useStore } from '@/store/useStore'
import { heatColor, heatBg, formatPremium } from '@/lib/utils'

export default function HeatMapPage() {
  const { flowEvents, connected } = useStore()

  const heatData = useMemo(() => {
    const byTicker: Record<string, { ticker: string; totalPremium: number; heat: number; count: number; calls: number; puts: number; sweeps: number }> = {}
    flowEvents.forEach(e => {
      if (!byTicker[e.underlying]) {
        byTicker[e.underlying] = { ticker: e.underlying, totalPremium: 0, heat: 0, count: 0, calls: 0, puts: 0, sweeps: 0 }
      }
      const t = byTicker[e.underlying]
      t.totalPremium += e.total_premium
      t.heat = Math.max(t.heat, e.heat_score)
      t.count++
      if (e.option_type === 'C') t.calls++
      else t.puts++
      if (e.order_type === 'SWEEP') t.sweeps++
    })
    return Object.values(byTicker).sort((a, b) => b.totalPremium - a.totalPremium)
  }, [flowEvents])

  const maxPremium = Math.max(...heatData.map(d => d.totalPremium), 1)

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: '#fafafa', marginBottom: 4 }}>🗺 Heat Score Map</h1>
        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>Premium-weighted heat across all tickers · Sorted by total flow</p>
      </div>

      {/*
        An empty heat map was unreachable until now: `useFlowFeed` seeded fifty
        invented events on mount, so there was always something to tile. With
        the fabricator gone this renders a bare grid and no explanation unless
        it says one.
      */}
      {heatData.length === 0 && (
        <div className="card" style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--text-muted)', marginBottom: 24 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Nothing to map yet</div>
          <div style={{ fontSize: 11, lineHeight: 1.7, maxWidth: 480, margin: '0 auto' }}>
            {connected
              ? 'The feed is connected and no signals have arrived. Tiles appear as the engine classifies flow.'
              : 'The flow feed is not connected, so there is no flow to weight. This map is built entirely from live signals.'}
          </div>
        </div>
      )}

      {/* Big tile heatmap */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 10, marginBottom: 24 }}>
        {heatData.slice(0, 20).map(d => {
          const intensityAlpha = 0.1 + (d.totalPremium / maxPremium) * 0.5
          return (
            <div
              key={d.ticker}
              className="card"
              style={{
                padding: 14,
                background: `rgba(${d.heat >= 75 ? '251,191,36' : d.heat >= 65 ? '249,115,22' : d.heat >= 40 ? '59,130,246' : '107,114,128'}, ${intensityAlpha})`,
                border: `1px solid ${heatColor(d.heat)}40`,
                cursor: 'default',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                <span style={{ fontWeight: 700, fontSize: 15, color: '#fafafa', fontFamily: "'JetBrains Mono', monospace" }}>{d.ticker}</span>
                <span style={{ fontSize: 14, fontWeight: 800, color: heatColor(d.heat), fontFamily: "'JetBrains Mono', monospace" }}>{d.heat}</span>
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#fafafa', marginBottom: 4, fontFamily: "'JetBrains Mono', monospace" }}>
                {formatPremium(d.totalPremium)}
              </div>
              <div style={{ display: 'flex', gap: 8, fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}>
                <span style={{ color: '#22c55e' }}>C:{d.calls}</span>
                <span style={{ color: '#ef4444' }}>P:{d.puts}</span>
                <span style={{ color: '#a78bfa' }}>SW:{d.sweeps}</span>
              </div>
              {/* Mini bar */}
              <div style={{ marginTop: 8, height: 3, background: 'var(--bg-secondary)', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${(d.totalPremium / maxPremium) * 100}%`, background: heatColor(d.heat), borderRadius: 2 }} />
              </div>
            </div>
          )
        })}
      </div>

      {/* Table */}
      <div className="card">
        <div className="card-header"><span style={{ fontWeight: 700, fontSize: 13 }}>HEAT SCORE TABLE — ALL TICKERS</span></div>
        <table className="flow-table">
          <thead>
            <tr>
              <th>TICKER</th>
              <th>HEAT</th>
              <th>TOTAL PREMIUM</th>
              <th>CALLS</th>
              <th>PUTS</th>
              <th>SWEEPS</th>
              <th>TRADES</th>
              <th>PREMIUM BAR</th>
            </tr>
          </thead>
          <tbody>
            {heatData.map(d => (
              <tr key={d.ticker}>
                <td><span className="ticker-pill">{d.ticker}</span></td>
                <td>
                  <span style={{ color: heatColor(d.heat), fontWeight: 700, fontSize: 13 }}>{d.heat}</span>
                </td>
                <td style={{ fontWeight: 600 }}>{formatPremium(d.totalPremium)}</td>
                <td style={{ color: '#22c55e' }}>{d.calls}</td>
                <td style={{ color: '#ef4444' }}>{d.puts}</td>
                <td style={{ color: '#a78bfa', fontWeight: d.sweeps > 0 ? 700 : 400 }}>{d.sweeps}</td>
                <td style={{ color: 'var(--text-secondary)' }}>{d.count}</td>
                <td style={{ width: 120 }}>
                  <div style={{ height: 6, background: 'var(--bg-secondary)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${(d.totalPremium / maxPremium) * 100}%`, background: heatColor(d.heat), borderRadius: 3 }} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
