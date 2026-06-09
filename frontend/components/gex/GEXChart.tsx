'use client'
import { useState, useMemo } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer, Cell } from 'recharts'
import { computeGEX } from '@/lib/blackScholes'
import { useStore } from '@/store/useStore'
import { formatNumber } from '@/lib/utils'

const UNDERLYING_SPOTS: Record<string, number> = {
  SPY: 557, QQQ: 472, NVDA: 942, MSTR: 376, MSFT: 428, SPX: 5587, IWM: 198, AAPL: 212,
}

export function GEXChart() {
  const { flowEvents, selectedTicker, setSelectedTicker } = useStore()
  const tickers = ['SPY', 'QQQ', 'NVDA', 'MSTR', 'MSFT', 'IWM', 'AAPL']
  const spotPrice = UNDERLYING_SPOTS[selectedTicker] || 500

  const gexData = useMemo(() => {
    const events = flowEvents.filter(e => e.underlying === selectedTicker)
    if (events.length === 0) {
      // generate synthetic GEX curve
      const strikes = Array.from({ length: 12 }, (_, i) => Math.round(spotPrice * (0.9 + i * 0.02) / 5) * 5)
      return strikes.map(s => ({
        strike: s,
        net_gex: (Math.random() * 40 - 15) * 1e6,
        call_gex: Math.random() * 30 * 1e6,
        put_gex: -Math.random() * 20 * 1e6,
        level_type: Math.random() > 0.5 ? 'SUPPORT' : 'RESISTANCE' as any,
      }))
    }
    const contracts = events.map(e => ({
      strike: e.strike,
      callOI: e.option_type === 'C' ? e.open_interest : 0,
      putOI: e.option_type === 'P' ? e.open_interest : 0,
      gamma: Math.abs(e.delta * 0.01) || 0.005,
      spotPrice,
    }))
    const grouped: Record<number, { callOI: number; putOI: number; gamma: number }> = {}
    contracts.forEach(c => {
      if (!grouped[c.strike]) grouped[c.strike] = { callOI: 0, putOI: 0, gamma: c.gamma }
      grouped[c.strike].callOI += c.callOI
      grouped[c.strike].putOI += c.putOI
    })
    return computeGEX(Object.entries(grouped).map(([k, v]) => ({ strike: Number(k), ...v, spotPrice })))
  }, [flowEvents, selectedTicker, spotPrice])

  const flipPoint = gexData.reduce((flip, d) => {
    const prev = gexData[gexData.indexOf(d) - 1]
    if (prev && Math.sign(prev.net_gex) !== Math.sign(d.net_gex)) return d.strike
    return flip
  }, 0)

  const keyLevels = [...gexData].sort((a, b) => Math.abs(b.net_gex) - Math.abs(a.net_gex)).slice(0, 6)

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null
    const d = payload[0]?.payload
    return (
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-light)', borderRadius: 6, padding: '10px 14px', fontSize: 12, fontFamily: "'JetBrains Mono', monospace" }}>
        <div style={{ color: '#a78bfa', fontWeight: 700, marginBottom: 6 }}>STRIKE ${label}</div>
        <div style={{ color: d?.net_gex >= 0 ? '#22c55e' : '#ef4444' }}>NET GEX: {d?.net_gex >= 0 ? '+' : ''}{formatNumber(Math.round(d?.net_gex / 1e6 * 10) / 10)}M</div>
        <div style={{ color: '#22c55e' }}>CALL GEX: +{formatNumber(Math.round(d?.call_gex / 1e6 * 10) / 10)}M</div>
        <div style={{ color: '#ef4444' }}>PUT GEX: {formatNumber(Math.round(d?.put_gex / 1e6 * 10) / 10)}M</div>
        <div style={{ marginTop: 4, color: d?.level_type === 'SUPPORT' ? '#22c55e' : '#ef4444', fontWeight: 600 }}>{d?.level_type}</div>
      </div>
    )
  }

  return (
    <div>
      {/* Ticker selector */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {tickers.map(t => (
          <button key={t} onClick={() => setSelectedTicker(t)} style={{
            padding: '5px 14px', borderRadius: 5, border: `1px solid ${selectedTicker === t ? 'rgba(139,92,246,0.5)' : 'var(--border)'}`,
            background: selectedTicker === t ? 'rgba(139,92,246,0.15)' : 'var(--bg-secondary)',
            color: selectedTicker === t ? '#a78bfa' : 'var(--text-secondary)',
            fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: "'JetBrains Mono', monospace",
          }}>
            {t}
          </button>
        ))}
        <span style={{ color: 'var(--text-secondary)', fontSize: 12, alignSelf: 'center', fontFamily: "'JetBrains Mono', monospace" }}>
          SPOT: <span style={{ color: '#fafafa', fontWeight: 600 }}>${spotPrice.toLocaleString()}</span>
        </span>
      </div>

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ marginBottom: 12 }}>
          <span style={{ fontWeight: 700, color: '#fafafa', fontSize: 13 }}>NET DEALER GAMMA EXPOSURE — {selectedTicker}</span>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
            Positive = dealers long gamma (stabilizing) · Negative = dealers short gamma (volatile)
          </div>
        </div>
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={gexData} margin={{ top: 10, right: 20, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
            <XAxis dataKey="strike" tick={{ fill: '#71717a', fontSize: 11, fontFamily: 'JetBrains Mono' }} tickFormatter={v => `$${v}`} />
            <YAxis tick={{ fill: '#71717a', fontSize: 11, fontFamily: 'JetBrains Mono' }} tickFormatter={v => `${(v/1e6).toFixed(0)}M`} />
            <Tooltip content={<CustomTooltip />} />
            <ReferenceLine y={0} stroke="#52525b" strokeWidth={1.5} />
            {flipPoint > 0 && <ReferenceLine x={flipPoint} stroke="#fbbf24" strokeDasharray="4 4" strokeWidth={1.5} label={{ value: 'FLIP', fill: '#fbbf24', fontSize: 10 }} />}
            <Bar dataKey="net_gex" radius={[2, 2, 0, 0]}>
              {gexData.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={entry.net_gex >= 0 ? '#22c55e' : '#ef4444'} fillOpacity={0.8} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Key GEX levels table */}
      <div className="card">
        <div className="card-header">
          <span style={{ fontWeight: 700, fontSize: 13 }}>KEY GEX LEVELS</span>
        </div>
        <table className="flow-table">
          <thead>
            <tr>
              <th>STRIKE</th>
              <th>NET GEX</th>
              <th>CALL GEX</th>
              <th>PUT GEX</th>
              <th>TYPE</th>
            </tr>
          </thead>
          <tbody>
            {keyLevels.map(l => (
              <tr key={l.strike}>
                <td style={{ fontWeight: 700, color: '#a78bfa' }}>${l.strike.toLocaleString()}</td>
                <td style={{ color: l.net_gex >= 0 ? '#22c55e' : '#ef4444', fontWeight: 700 }}>
                  {l.net_gex >= 0 ? '+' : ''}{(l.net_gex / 1e6).toFixed(2)}M
                </td>
                <td style={{ color: '#86efac' }}>+{(l.call_gex / 1e6).toFixed(2)}M</td>
                <td style={{ color: '#fca5a5' }}>{(l.put_gex / 1e6).toFixed(2)}M</td>
                <td>
                  <span style={{ color: l.level_type === 'SUPPORT' ? '#22c55e' : l.level_type === 'FLIP' ? '#fbbf24' : '#ef4444', fontWeight: 700, fontSize: 11 }}>
                    {l.level_type}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
