'use client'
import { useState } from 'react'
import { useStore } from '@/store/useStore'
import { formatPremium, heatColor } from '@/lib/utils'
import { pctColor, spotPrice, signedPct } from '@/lib/format'
import { useSpotQuotes, isStale, asOf } from '@/lib/spotQuotes'

/**
 * The card price came from a hardcoded 2024 map.
 *
 * `SPOT_PRICES` held fifteen levels — SPX 5587, SPY 557, NVDA 942, TSLA 182 —
 * and rendered them under each ticker in the same monospace as the flow
 * statistics beside them, with nothing marking them as anything but the
 * current price. It was the ticker tape's base map with the `Math.random()`
 * jitter left off, surviving in a second file after the tape lost its own.
 *
 * A hand-maintained list in front of a feed also drifts from it: this one
 * carried MU, MRVL, IWM, GLD and SOXL, which the spot connector does not
 * cover, so those five could never have been right even in 2024 — the same
 * defect that retired the tape's fifteen-entry `TICKERS` const.
 *
 * Prices now come from `/api/macro/quotes`, and a ticker with no quote behind
 * it shows no price. The feed's own state is not reported here: `TopBar` is
 * mounted in `app/layout.tsx` and already says whether the tape is empty,
 * refused or unreachable, above the fold of this page. A second copy of that
 * message is a second copy to keep correct.
 */

export default function WatchlistPage() {
  const { watchlist, addToWatchlist, removeFromWatchlist, flowEvents } = useStore()
  const [input, setInput] = useState('')
  const { quote } = useSpotQuotes()

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
          const q = quote(ticker)
          const stale = q ? isStale(q) : false
          return (
            <div key={ticker} className="card" style={{ padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: '#fafafa', fontFamily: "'JetBrains Mono', monospace" }}>{ticker}</div>
                  {q && (
                    <div style={{ fontSize: 12, fontFamily: "'JetBrains Mono', monospace", marginTop: 2, opacity: stale ? 0.6 : 1, display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
                      <span style={{ color: 'var(--text-secondary)' }}>${spotPrice(q.price)}</span>
                      <span style={{ color: pctColor(q.changePct) }}>{signedPct(q.changePct)}</span>
                      {stale && <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>AS OF {asOf(q)} ET</span>}
                    </div>
                  )}
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
