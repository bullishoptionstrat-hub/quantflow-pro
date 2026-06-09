'use client'
import { useState, useEffect } from 'react'
import { useStore } from '@/store/useStore'
import { formatPremium } from '@/lib/utils'

const TICKERS = ['SPX','SPY','QQQ','NVDA','MSTR','MSFT','AAPL','META','TSLA','AMD','MU','MRVL','IWM','GLD','SOXL']

interface Quote { ticker: string; price: number; chg: number; pct: number }

function generateQuotes(): Quote[] {
  const base: Record<string, number> = {
    SPX:5587, SPY:557, QQQ:472, NVDA:942, MSTR:376, MSFT:428, AAPL:212, META:503,
    TSLA:182, AMD:155, MU:94, MRVL:71, IWM:198, GLD:235, SOXL:22,
  }
  return TICKERS.map(t => {
    const p = base[t] || 100
    const chg = parseFloat(((Math.random() * 4 - 1.5)).toFixed(2))
    return { ticker: t, price: parseFloat((p + chg).toFixed(2)), chg, pct: parseFloat((chg/p*100).toFixed(2)) }
  })
}

export function TopBar() {
  const [quotes, setQuotes] = useState<Quote[]>(generateQuotes())
  const [time, setTime] = useState<string>('')
  const { powerAlerts, flowEvents } = useStore()
  const newAlerts = powerAlerts.filter(a => Date.now() - new Date(a.created_at).getTime() < 300_000).length
  const totalPremium = flowEvents.reduce((s, e) => s + e.total_premium, 0)

  useEffect(() => {
    const tick = () => {
      setTime(new Date().toLocaleTimeString('en-US', { hour12: false, timeZone: 'America/New_York' }))
    }
    tick()
    const id = setInterval(() => {
      tick()
      if (Math.random() > 0.7) setQuotes(generateQuotes())
    }, 10000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="topbar" style={{ justifyContent: 'space-between' }}>
      {/* Scrolling ticker */}
      <div style={{ flex: 1, overflow: 'hidden', maskImage: 'linear-gradient(90deg,transparent,black 40px,black calc(100% - 40px),transparent)' }}>
        <div style={{ display: 'flex', gap: 24, animation: 'none', overflowX: 'auto', scrollbarWidth: 'none' }}>
          {quotes.map(q => (
            <span key={q.ticker} style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
              <span style={{ color: '#a78bfa', fontWeight: 600 }}>{q.ticker}</span>
              <span style={{ color: '#fafafa' }}>${q.price.toFixed(q.price > 100 ? 2 : 2)}</span>
              <span style={{ color: q.chg >= 0 ? '#22c55e' : '#ef4444' }}>{q.chg >= 0 ? '+' : ''}{q.pct.toFixed(2)}%</span>
            </span>
          ))}
        </div>
      </div>

      {/* Right: stats */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0, paddingLeft: 16 }}>
        {newAlerts > 0 && (
          <span style={{ background: 'rgba(249,115,22,0.15)', border: '1px solid rgba(249,115,22,0.4)', color: '#fb923c', fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 12, fontFamily: "'JetBrains Mono', monospace" }}>
            ⚡ {newAlerts} ALERTS
          </span>
        )}
        <span style={{ color: 'var(--text-secondary)', fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>
          TOTAL PREM <span style={{ color: '#fbbf24', fontWeight: 700 }}>{formatPremium(totalPremium)}</span>
        </span>
        <span style={{ color: 'var(--text-muted)', fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>
          {time} ET
        </span>
      </div>
    </div>
  )
}
