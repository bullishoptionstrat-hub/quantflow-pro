'use client'
import { useState } from 'react'
import { useStore } from '@/store/useStore'
import { formatPremium, heatColor } from '@/lib/utils'

const SPOT_PRICES: Record<string, number> = {
  SPX: 5587, SPY: 557, QQQ: 472, NVDA: 942, MSTR: 376, MSFT: 428, AAPL: 212,
  META: 503, TSLA: 182, AMD: 155, MU: 94, MRVL: 71, IWM: 198, GLD: 235, SOXL: 22,
}

export default function WatchlistPage() {
  const { watchlist, addToWatchlist, removeFromWatchlist, flowEvents } = useStore()
  const [input, setInput] = useState('')

  const handleAdd = () => {
    if (!input.trim()) return
    addToWatchlist(input.trim().toUpperCase())
    setInput('')
  }

  const getTickerStats = (ticker: string) => {
    const events = flowEvents.filter(e => e.underlying === ticker)
    return {
      totalPremium: events.reduce((s, e) => s + e.total_premium, 0),
      maxHeat: events.length > 0 ? Math.max(...events.map(e => e.heat_score)) : 0,
      calls: events.filter(e => e.option_type === 'C').length,
      puts: events.filter(e => e.option_type === 'P').length,
      sweeps: events.filter(e => e.order_type === 'SWEEP').length,
      count: events.length,
    }
  }

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: '#fafafa', marginBottom: 4 }}>★ Watchlist</h1>
        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>Track options flow for your favorite tickers</p>
      </div>

      {/* Add ticker */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
        <input
          type="text"
          placeholder="Add ticker (e.g. AAPL)"
          value={input}
          onChange={e => setInput(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === 'Enter' && handleAdd()}
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-light)', color: 'var(--text-primary)', borderRadius: 6, padding: '8px 14px', fontSize: 13, fontFamily: "'JetBrains Mono', monospace", outline: 'none', width: 200 }}
        />
        <button
          onClick={handleAdd}
          style={{ background: 'rgba(139,92,246,0.15)', border: '1px solid rgba(139,92,246,0.4)', color: '#a78bfa', padding: '8px 18px', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
        >
          + Add
        </button>
      </div>

      {/* Watchlist cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
        {watchlist.map(ticker => {
          const stats = getTickerStats(ticker)
          const spot = SPOT_PRICES[ticker]
          return (
            <div key={ticker} className="card" style={{ padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: '#fafafa', fontFamily: "'JetBrains Mono', monospace" }}>{ticker}</div>
                  {spot && <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: "'JetBrains Mono', monospace', marginTop: 2" }}>${spot.toLocaleString()}</div>}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {stats.maxHeat > 0 && (
                    <span style={{ color: heatColor(stats.maxHeat), fontWeight: 800, fontSize: 16, fontFamily: "'JetBrains Mono', monospace" }}>{stats.maxHeat}</span>
                  )}
                  <button
                    onClick={() => removeFromWatchlist(ticker)}
                    style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: 12, padding: '4px 8px', borderRadius: 4, cursor: 'pointer' }}
                  >
                    ✕
                  </button>
                </div>
              </div>
              {stats.count > 0 ? (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <div>
                    <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: '0.08em', fontWeight: 600, marginBottom: 2 }}>TOTAL PREM</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#fafafa', fontFamily: "'JetBrains Mono', monospace" }}>{formatPremium(stats.totalPremium)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: '0.08em', fontWeight: 600, marginBottom: 2 }}>TRADES</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#a78bfa', fontFamily: "'JetBrains Mono', monospace" }}>{stats.count}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: '0.08em', fontWeight: 600, marginBottom: 2 }}>CALLS/PUTS</div>
                    <div style={{ fontSize: 13, fontFamily: "'JetBrains Mono', monospace" }}>
                      <span style={{ color: '#22c55e' }}>{stats.calls}C</span>
                      {' / '}
                      <span style={{ color: '#ef4444' }}>{stats.puts}P</span>
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: '0.08em', fontWeight: 600, marginBottom: 2 }}>SWEEPS</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#8b5cf6', fontFamily: "'JetBrains Mono', monospace" }}>{stats.sweeps}</div>
                  </div>
                </div>
              ) : (
                <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>No flow data yet</div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
