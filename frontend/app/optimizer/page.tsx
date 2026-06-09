'use client'
import { useState, useMemo } from 'react'
import { blackScholes } from '@/lib/blackScholes'

const STRATEGIES = [
  { id: 'long_call', name: 'Long Call', desc: 'Bullish · Unlimited upside' },
  { id: 'long_put', name: 'Long Put', desc: 'Bearish · Unlimited downside profit' },
  { id: 'bull_call_spread', name: 'Bull Call Spread', desc: 'Bullish · Defined risk/reward' },
  { id: 'bear_put_spread', name: 'Bear Put Spread', desc: 'Bearish · Defined risk/reward' },
  { id: 'straddle', name: 'Long Straddle', desc: 'Volatility play · Any direction' },
  { id: 'iron_condor', name: 'Iron Condor', desc: 'Neutral · Premium collection' },
]

export default function OptimizerPage() {
  const [spot, setSpot] = useState(557)
  const [iv, setIv] = useState(15)
  const [dte, setDte] = useState(21)
  const [selected, setSelected] = useState('bull_call_spread')

  const T = Math.max(dte / 365, 0.01)
  const atm = Math.round(spot / 5) * 5
  const sigma = iv / 100

  const recommendations = useMemo(() => {
    return STRATEGIES.map(s => {
      let risk = 0, reward = 0, prob = 0, legs: string[] = []
      if (s.id === 'long_call') {
        const bs = blackScholes('C', { S: spot, K: atm, T, r: 0.05, sigma })
        risk = bs.price * 100
        reward = Infinity
        prob = bs.delta * 100
        legs = [`BUY ${atm}C @ $${bs.price.toFixed(2)}`]
      } else if (s.id === 'long_put') {
        const bs = blackScholes('P', { S: spot, K: atm, T, r: 0.05, sigma })
        risk = bs.price * 100
        reward = atm * 100 - risk
        prob = (1 - bs.delta) * 100
        legs = [`BUY ${atm}P @ $${bs.price.toFixed(2)}`]
      } else if (s.id === 'bull_call_spread') {
        const lower = blackScholes('C', { S: spot, K: atm, T, r: 0.05, sigma })
        const upper = blackScholes('C', { S: spot, K: atm * 1.05, T, r: 0.05, sigma })
        risk = (lower.price - upper.price) * 100
        reward = (atm * 0.05 - (lower.price - upper.price)) * 100
        prob = lower.delta * 100
        legs = [`BUY ${atm}C @ $${lower.price.toFixed(2)}`, `SELL ${Math.round(atm * 1.05 / 5) * 5}C @ $${upper.price.toFixed(2)}`]
      } else if (s.id === 'straddle') {
        const call = blackScholes('C', { S: spot, K: atm, T, r: 0.05, sigma })
        const put = blackScholes('P', { S: spot, K: atm, T, r: 0.05, sigma })
        risk = (call.price + put.price) * 100
        reward = Infinity
        prob = 50
        legs = [`BUY ${atm}C @ $${call.price.toFixed(2)}`, `BUY ${atm}P @ $${put.price.toFixed(2)}`]
      } else if (s.id === 'iron_condor') {
        const sellPut = blackScholes('P', { S: spot, K: atm * 0.97, T, r: 0.05, sigma })
        const buyPut = blackScholes('P', { S: spot, K: atm * 0.95, T, r: 0.05, sigma })
        const sellCall = blackScholes('C', { S: spot, K: atm * 1.03, T, r: 0.05, sigma })
        const buyCall = blackScholes('C', { S: spot, K: atm * 1.05, T, r: 0.05, sigma })
        const credit = (sellPut.price - buyPut.price + sellCall.price - buyCall.price) * 100
        risk = (atm * 0.02 * 100) - credit
        reward = credit
        prob = 70
        legs = [
          `SELL ${Math.round(atm * 0.97 / 5) * 5}P`, `BUY ${Math.round(atm * 0.95 / 5) * 5}P`,
          `SELL ${Math.round(atm * 1.03 / 5) * 5}C`, `BUY ${Math.round(atm * 1.05 / 5) * 5}C`,
        ]
      } else {
        risk = 100; reward = 200; prob = 50; legs = ['—']
      }
      const rr = reward === Infinity ? '∞' : (reward / Math.max(risk, 1)).toFixed(2)
      const score = Math.round(prob * 0.4 + (reward === Infinity ? 40 : Math.min(reward / Math.max(risk, 1) * 20, 40)) + (iv < 20 ? 20 : iv < 30 ? 15 : 5))
      return { ...s, risk: Math.round(risk), reward: reward === Infinity ? Infinity : Math.round(reward), prob: Math.round(prob), rr, legs, score }
    }).sort((a, b) => b.score - a.score)
  }, [spot, iv, dte])

  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)',
    borderRadius: 5, padding: '6px 10px', fontSize: 13, fontFamily: "'JetBrains Mono', monospace", outline: 'none',
  }

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: '#fafafa', marginBottom: 4 }}>⚙ Strategy Optimizer</h1>
        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>AI-ranked strategy recommendations based on current conditions</p>
      </div>

      <div className="card" style={{ padding: 16, marginBottom: 20, display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap' }}>
        {[
          { label: 'SPOT PRICE', value: spot, setter: setSpot, min: 10, max: 6000, step: 1 },
          { label: `IV: ${iv}%`, value: iv, setter: setIv, min: 5, max: 150, step: 1 },
          { label: `DTE: ${dte}`, value: dte, setter: setDte, min: 1, max: 180, step: 1 },
        ].map(p => (
          <div key={p.label} style={{ flex: 1, minWidth: 200 }}>
            <label style={{ fontSize: 10, color: 'var(--text-muted)', display: 'block', marginBottom: 6, fontWeight: 600, letterSpacing: '0.08em' }}>{p.label}</label>
            <input type="range" min={p.min} max={p.max} value={p.value} step={p.step}
              onChange={e => p.setter(Number(e.target.value))} style={{ width: '100%', accentColor: '#8b5cf6' }} />
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {recommendations.map((s, rank) => (
          <div
            key={s.id}
            className="card"
            onClick={() => setSelected(s.id)}
            style={{ padding: 16, cursor: 'pointer', borderColor: selected === s.id ? 'rgba(139,92,246,0.5)' : undefined, background: selected === s.id ? 'rgba(139,92,246,0.06)' : undefined }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 800, color: rank === 0 ? '#fbbf24' : 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>#{rank + 1}</span>
                  <span style={{ fontWeight: 700, fontSize: 14, color: '#fafafa' }}>{s.name}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{s.desc}</span>
                </div>
                <div style={{ display: 'flex', gap: 12, fontSize: 11, fontFamily: "'JetBrains Mono', monospace", flexWrap: 'wrap' }}>
                  {s.legs.map((l, i) => (
                    <span key={i} style={{ background: 'var(--bg-secondary)', padding: '2px 8px', borderRadius: 4, color: 'var(--text-secondary)' }}>{l}</span>
                  ))}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 16, flexShrink: 0, textAlign: 'center' }}>
                <div>
                  <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: '0.08em', fontWeight: 600, marginBottom: 3 }}>RISK</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#ef4444', fontFamily: "'JetBrains Mono', monospace" }}>${s.risk}</div>
                </div>
                <div>
                  <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: '0.08em', fontWeight: 600, marginBottom: 3 }}>REWARD</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#22c55e', fontFamily: "'JetBrains Mono', monospace" }}>{s.reward === Infinity ? '∞' : `$${s.reward}`}</div>
                </div>
                <div>
                  <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: '0.08em', fontWeight: 600, marginBottom: 3 }}>R/R</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#60a5fa', fontFamily: "'JetBrains Mono', monospace" }}>{s.rr}x</div>
                </div>
                <div>
                  <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: '0.08em', fontWeight: 600, marginBottom: 3 }}>SCORE</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: rank === 0 ? '#fbbf24' : '#a78bfa', fontFamily: "'JetBrains Mono', monospace" }}>{s.score}</div>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
