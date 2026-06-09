'use client'
import { useState, useEffect } from 'react'
import { formatPremium, formatTime } from '@/lib/utils'
import { HeatBadge } from '@/components/ui/HeatBadge'
import { TableSkeleton } from '@/components/ui/Skeleton'
import type { DarkPoolPrint } from '@/lib/types'

const EXCHANGES = ['NYSE', 'NASDAQ', 'CBOE', 'BATS', 'IEX', 'DARK_NYSE', 'DARK_NASDAQ']

function generateDarkPool(count = 30): DarkPoolPrint[] {
  const tickers = ['NVDA','AAPL','MSFT','META','TSLA','AMZN','GOOGL','AMD','MU','MRVL','SPY','QQQ','IWM','GLD','XLF','SOXL']
  return Array.from({ length: count }, (_, i) => {
    const ticker = tickers[Math.floor(Math.random() * tickers.length)]
    const price = ticker === 'AAPL' ? 212 : ticker === 'MSFT' ? 428 : ticker === 'NVDA' ? 942 : Math.floor(Math.random() * 300 + 50)
    const size = Math.floor(Math.random() * 800000 + 10000)
    const notional = price * size
    return {
      id: `dp-${i}-${Date.now()}`,
      symbol: ticker,
      price,
      size,
      notional,
      exchange: EXCHANGES[Math.floor(Math.random() * EXCHANGES.length)],
      condition: ['', 'BLOCK', 'SWEEP_DARK', 'INTERMARKET'][Math.floor(Math.random() * 4)],
      created_at: new Date(Date.now() - i * 120000).toISOString(),
      is_block: notional > 5_000_000,
      repeat_count: Math.floor(Math.random() * 5),
    }
  }).sort((a, b) => b.notional - a.notional)
}

export default function DarkPoolPage() {
  const [prints, setPrints] = useState<DarkPoolPrint[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setTimeout(() => { setPrints(generateDarkPool(30)); setLoading(false) }, 800)
    const id = setInterval(() => {
      setPrints(prev => {
        const [newPrint] = generateDarkPool(1)
        return [{ ...newPrint, created_at: new Date().toISOString() }, ...prev].slice(0, 200)
      })
    }, 20000)
    return () => clearInterval(id)
  }, [])

  const totalNotional = prints.reduce((s, p) => s + p.notional, 0)
  const blocks = prints.filter(p => p.is_block).length

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: '#fafafa', marginBottom: 4 }}>🌑 Dark Pool Prints</h1>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>Off-exchange institutional block trades · 24-hour delay disclaimer</p>
          <span style={{ background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.3)', color: '#fbbf24', fontSize: 10, padding: '2px 8px', borderRadius: 4, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>
            ⚠ 24-HOUR DELAY
          </span>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 16 }}>
        {[
          { label: 'TOTAL NOTIONAL', value: formatPremium(totalNotional), color: '#fafafa' },
          { label: 'BLOCK TRADES', value: blocks.toString(), color: '#fbbf24' },
          { label: 'PRINTS TODAY', value: prints.length.toString(), color: '#a78bfa' },
        ].map(s => (
          <div key={s.label} className="card" style={{ padding: '12px 14px' }}>
            <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: '0.1em', fontWeight: 600, marginBottom: 6 }}>{s.label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: s.color, fontFamily: "'JetBrains Mono', monospace" }}>{s.value}</div>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="card-header">
          <span style={{ fontWeight: 700, fontSize: 13 }}>🌑 DARK POOL PRINTS</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>{prints.length} prints</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="flow-table">
            <thead>
              <tr>
                <th>TIME</th>
                <th>SYMBOL</th>
                <th>PRICE</th>
                <th>SIZE</th>
                <th>NOTIONAL</th>
                <th>EXCHANGE</th>
                <th>CONDITION</th>
                <th>REPEAT</th>
              </tr>
            </thead>
            {loading ? <TableSkeleton rows={10} /> : (
              <tbody>
                {prints.map(p => (
                  <tr key={p.id} style={{ borderLeft: p.is_block ? '2px solid #fbbf24' : '2px solid transparent' }}>
                    <td style={{ color: 'var(--text-muted)', fontSize: 11 }}>{formatTime(p.created_at)}</td>
                    <td><span className="ticker-pill">{p.symbol}</span></td>
                    <td style={{ fontWeight: 600 }}>${p.price.toFixed(2)}</td>
                    <td>{p.size.toLocaleString()}</td>
                    <td style={{ color: p.is_block ? '#fbbf24' : '#fafafa', fontWeight: p.is_block ? 700 : 400 }}>
                      {p.is_block ? '🐋 ' : ''}{formatPremium(p.notional)}
                    </td>
                    <td style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: "'JetBrains Mono', monospace" }}>{p.exchange}</td>
                    <td>
                      {p.condition && (
                        <span style={{ background: 'rgba(139,92,246,0.1)', color: '#a78bfa', fontSize: 10, padding: '2px 6px', borderRadius: 3, fontFamily: "'JetBrains Mono', monospace" }}>
                          {p.condition}
                        </span>
                      )}
                    </td>
                    <td style={{ color: p.repeat_count > 2 ? '#f97316' : 'var(--text-muted)', fontWeight: p.repeat_count > 2 ? 700 : 400 }}>
                      {p.repeat_count > 0 ? `×${p.repeat_count}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>
      </div>
    </div>
  )
}
