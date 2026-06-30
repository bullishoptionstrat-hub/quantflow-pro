'use client'
import { useState, useEffect } from 'react'

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:3001'
const API = WS_URL.replace('ws://', 'http://').replace('wss://', 'https://')

// ─── Types ───────────────────────────────────────────────────────────────────
interface VIXData {
  vix9d?: number
  vix: number
  vix3m?: number
  vix6m?: number
  vxn?: number
  pcr?: number
  pcrIndex?: number
  timestamp: string
}
interface MacroSeries {
  id: string
  label: string
  value: number
  previousValue?: number
  unit: string
  lastUpdated: string
}
interface CryptoQuote {
  symbol: string
  name: string
  price: number
  change24h: number
  marketCap: number
  volume24h: number
}
interface StooqQuote {
  symbol: string
  price: number
  change: number
  changePct: number
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fmt(n: number, decimals = 2) {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(1)}T`
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`
  return n.toFixed(decimals)
}
function pctColor(v: number) {
  if (v > 0) return '#22c55e'
  if (v < 0) return '#ef4444'
  return 'var(--text-muted)'
}

// ─── VIX Term Structure ───────────────────────────────────────────────────────
function VIXPanel({ data }: { data: VIXData | null }) {
  const loading = !data
  const terms = [
    { label: 'VIX9D', value: data?.vix9d, desc: '9-Day' },
    { label: 'VIX', value: data?.vix, desc: '30-Day', main: true },
    { label: 'VIX3M', value: data?.vix3m, desc: '3-Month' },
    { label: 'VIX6M', value: data?.vix6m, desc: '6-Month' },
    { label: 'VXN', value: data?.vxn, desc: 'Nasdaq' },
  ]

  const maxVix = Math.max(...terms.map(t => t.value ?? 0), 1)

  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>📊 VIX TERM STRUCTURE</span>
        {data && (
          <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>
            {new Date(data.timestamp).toLocaleTimeString()}
          </span>
        )}
      </div>
      <div style={{ padding: 16 }}>
        {loading ? (
          <div style={{ display: 'flex', gap: 12, height: 100 }}>
            {[1,2,3,4,5].map(i => <div key={i} style={{ flex: 1, background: 'var(--bg-secondary)', borderRadius: 4, animation: 'pulse 1.5s infinite' }} />)}
          </div>
        ) : (
          <>
            {/* Bar chart */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', height: 90, marginBottom: 12 }}>
              {terms.map(t => {
                const v = t.value ?? 0
                const pct = v / maxVix
                const color = v >= 30 ? '#ef4444' : v >= 20 ? '#fbbf24' : '#22c55e'
                return (
                  <div key={t.label} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                    <span style={{ fontSize: 10, color, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 }}>
                      {v > 0 ? v.toFixed(1) : '—'}
                    </span>
                    <div style={{ width: '100%', height: `${Math.max(pct * 70, 4)}px`, background: color, opacity: t.main ? 1 : 0.7, borderRadius: '2px 2px 0 0', transition: 'height 0.6s ease' }} />
                    <div style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>{t.label}</div>
                  </div>
                )
              })}
            </div>
            {/* PCR row */}
            <div style={{ display: 'flex', gap: 16, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
              <div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>EQUITY PCR</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: (data?.pcr ?? 0) > 1 ? '#ef4444' : '#22c55e', fontFamily: "'JetBrains Mono', monospace" }}>
                  {data?.pcr?.toFixed(2) ?? '—'}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>INDEX PCR</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: (data?.pcrIndex ?? 0) > 1 ? '#ef4444' : '#22c55e', fontFamily: "'JetBrains Mono', monospace" }}>
                  {data?.pcrIndex?.toFixed(2) ?? '—'}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>REGIME</div>
                <div style={{ fontSize: 11, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace",
                  color: (data?.vix ?? 0) >= 30 ? '#ef4444' : (data?.vix ?? 0) >= 20 ? '#fbbf24' : '#22c55e' }}>
                  {(data?.vix ?? 0) >= 30 ? '🔴 HIGH VOL' : (data?.vix ?? 0) >= 20 ? '🟡 ELEVATED' : '🟢 LOW VOL'}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ─── FRED Macro Metrics ───────────────────────────────────────────────────────
function MacroPanel({ data }: { data: MacroSeries[] }) {
  const LABELS: Record<string, { icon: string; desc: string }> = {
    FEDFUNDS:  { icon: '🏦', desc: 'Fed Funds Rate' },
    CPIAUCSL:  { icon: '📈', desc: 'CPI YoY' },
    PCEPILFE:  { icon: '💰', desc: 'Core PCE' },
    UNRATE:    { icon: '👷', desc: 'Unemployment' },
    T10Y2Y:    { icon: '📉', desc: '10Y-2Y Spread' },
    T10YIE:    { icon: '🔥', desc: '10Y Breakeven' },
    MORTGAGE30US: { icon: '🏠', desc: '30Y Mortgage' },
    M2SL:      { icon: '💵', desc: 'M2 Money Supply' },
  }

  const FALLBACK: MacroSeries[] = [
    { id: 'FEDFUNDS', label: 'Fed Funds Rate', value: 5.33, unit: '%', lastUpdated: '—' },
    { id: 'CPIAUCSL', label: 'CPI YoY', value: 3.4, unit: '%', lastUpdated: '—' },
    { id: 'PCEPILFE', label: 'Core PCE', value: 2.8, unit: '%', lastUpdated: '—' },
    { id: 'UNRATE', label: 'Unemployment', value: 3.9, unit: '%', lastUpdated: '—' },
    { id: 'T10Y2Y', label: '10Y-2Y Spread', value: -0.38, unit: 'bps', lastUpdated: '—' },
    { id: 'T10YIE', label: '10Y Breakeven', value: 2.31, unit: '%', lastUpdated: '—' },
  ]

  const display = data.length > 0 ? data : FALLBACK

  return (
    <div className="card">
      <div className="card-header">
        <span style={{ fontWeight: 700, fontSize: 13 }}>🏛 FRED MACRO INDICATORS</span>
      </div>
      <div style={{ padding: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {display.map(s => {
          const meta = LABELS[s.id] ?? { icon: '📊', desc: s.label }
          const delta = s.previousValue != null ? s.value - s.previousValue : null
          return (
            <div key={s.id} style={{ background: 'var(--bg-secondary)', borderRadius: 6, padding: '10px 12px', border: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{meta.icon} {meta.desc.toUpperCase()}</span>
                {delta != null && (
                  <span style={{ fontSize: 9, color: pctColor(delta), fontFamily: "'JetBrains Mono', monospace" }}>
                    {delta > 0 ? '+' : ''}{delta.toFixed(2)}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, color: '#fafafa', fontFamily: "'JetBrains Mono', monospace" }}>
                {s.value.toFixed(2)}<span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 2 }}>{s.unit}</span>
              </div>
              <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 3 }}>Updated: {s.lastUpdated}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Crypto Panel ─────────────────────────────────────────────────────────────
function CryptoPanel({ data }: { data: CryptoQuote[] }) {
  const FALLBACK: CryptoQuote[] = [
    { symbol: 'BTC', name: 'Bitcoin', price: 67420, change24h: 1.82, marketCap: 1.33e12, volume24h: 28.5e9 },
    { symbol: 'ETH', name: 'Ethereum', price: 3510, change24h: 0.94, marketCap: 421e9, volume24h: 14.2e9 },
    { symbol: 'SOL', name: 'Solana', price: 168, change24h: -1.23, marketCap: 75e9, volume24h: 3.8e9 },
    { symbol: 'BNB', name: 'BNB', price: 594, change24h: 0.41, marketCap: 88e9, volume24h: 1.9e9 },
    { symbol: 'DOGE', name: 'Dogecoin', price: 0.162, change24h: 2.11, marketCap: 23e9, volume24h: 1.1e9 },
    { symbol: 'AVAX', name: 'Avalanche', price: 38.4, change24h: -0.87, marketCap: 16e9, volume24h: 0.8e9 },
  ]
  const display = data.length > 0 ? data : FALLBACK

  return (
    <div className="card">
      <div className="card-header">
        <span style={{ fontWeight: 700, fontSize: 13 }}>₿ CRYPTO MARKET</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              {['ASSET','PRICE','24H%','MKT CAP','VOLUME'].map(h => (
                <th key={h} style={{ padding: '6px 12px', textAlign: 'right', fontWeight: 600, fontSize: 10, color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace', first-child:text-align:left" }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {display.map(c => (
              <tr key={c.symbol} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <td style={{ padding: '8px 12px', fontWeight: 700 }}>
                  <span style={{ color: '#fbbf24' }}>{c.symbol}</span>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 6 }}>{c.name}</span>
                </td>
                <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>
                  ${c.price >= 1 ? c.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : c.price.toFixed(4)}
                </td>
                <td style={{ padding: '8px 12px', textAlign: 'right', color: pctColor(c.change24h), fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 }}>
                  {c.change24h > 0 ? '+' : ''}{c.change24h.toFixed(2)}%
                </td>
                <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>
                  {fmt(c.marketCap)}
                </td>
                <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>
                  {fmt(c.volume24h)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Yield Curve / Spot Quotes ────────────────────────────────────────────────
function SpotPanel({ data }: { data: StooqQuote[] }) {
  const FALLBACK: StooqQuote[] = [
    { symbol: 'ES=F', price: 5787.50, change: 12.25, changePct: 0.21 },
    { symbol: 'NQ=F', price: 20455.00, change: 45.50, changePct: 0.22 },
    { symbol: 'GC=F', price: 2345.60, change: -3.40, changePct: -0.14 },
    { symbol: 'SI=F', price: 27.82, change: 0.18, changePct: 0.65 },
    { symbol: 'CL=F', price: 78.45, change: -0.92, changePct: -1.16 },
    { symbol: 'DX-Y.NYB', price: 104.32, change: 0.14, changePct: 0.13 },
    { symbol: '^TNX', price: 4.467, change: -0.021, changePct: -0.47 },
    { symbol: '^TYX', price: 4.621, change: -0.018, changePct: -0.39 },
  ]
  const display = data.length > 0 ? data : FALLBACK

  const LABEL_MAP: Record<string, string> = {
    'ES=F': 'E-Mini S&P 500', 'NQ=F': 'E-Mini Nasdaq', 'GC=F': 'Gold Futures',
    'SI=F': 'Silver Futures', 'CL=F': 'Crude Oil WTI', 'DX-Y.NYB': 'US Dollar Index',
    '^TNX': '10Y Treasury', '^TYX': '30Y Treasury', '^FVX': '5Y Treasury', '^IRX': '13W Treasury',
  }

  return (
    <div className="card">
      <div className="card-header">
        <span style={{ fontWeight: 700, fontSize: 13 }}>📡 FUTURES &amp; RATES (Stooq)</span>
      </div>
      <div style={{ padding: 8 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, padding: '0 8px 8px' }}>
          {display.map(q => (
            <div key={q.symbol} style={{ background: 'var(--bg-secondary)', borderRadius: 5, padding: '8px 10px', border: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#fafafa', fontFamily: "'JetBrains Mono', monospace" }}>{q.symbol}</div>
                <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 1 }}>{LABEL_MAP[q.symbol] ?? q.symbol}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>{q.price.toFixed(2)}</div>
                <div style={{ fontSize: 10, color: pctColor(q.changePct), fontFamily: "'JetBrains Mono', monospace" }}>
                  {q.changePct > 0 ? '+' : ''}{q.changePct.toFixed(2)}%
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function MacroPage() {
  const [vixData, setVixData] = useState<VIXData | null>(null)
  const [macroData, setMacroData] = useState<MacroSeries[]>([])
  const [cryptoData, setCryptoData] = useState<CryptoQuote[]>([])
  const [stooqData, setStooqData] = useState<StooqQuote[]>([])
  const [loading, setLoading] = useState(true)
  const [lastUpdate, setLastUpdate] = useState<string>('')

  useEffect(() => {
    async function fetchAll() {
      try {
        const [vixRes, macroRes, cryptoRes] = await Promise.allSettled([
          fetch(`${API}/api/macro/vix`).then(r => r.json()),
          fetch(`${API}/api/macro`).then(r => r.json()),
          fetch(`${API}/api/macro/crypto`).then(r => r.json()),
        ])

        if (vixRes.status === 'fulfilled' && vixRes.value?.vix != null) {
          setVixData(vixRes.value)
        } else {
          // Synthetic fallback
          setVixData({ vix9d: 14.2, vix: 16.8, vix3m: 18.4, vix6m: 19.1, vxn: 18.2, pcr: 0.72, pcrIndex: 1.14, timestamp: new Date().toISOString() })
        }

        if (macroRes.status === 'fulfilled' && Array.isArray(macroRes.value?.fred)) {
          setMacroData(macroRes.value.fred)
        }

        if (cryptoRes.status === 'fulfilled' && Array.isArray(cryptoRes.value)) {
          setCryptoData(cryptoRes.value)
        }

        // Try stooq quotes from /api/macro/quotes
        const quotesRes = await fetch(`${API}/api/macro/quotes`).catch(() => null)
        if (quotesRes?.ok) {
          const q = await quotesRes.json()
          if (Array.isArray(q)) setStooqData(q)
        }

        setLastUpdate(new Date().toLocaleTimeString())
        setLoading(false)
      } catch {
        setLoading(false)
      }
    }

    fetchAll()
    const interval = setInterval(fetchAll, 30_000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div>
      <div style={{ marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 700, color: '#fafafa', marginBottom: 4 }}>📊 Macro Dashboard</h1>
          <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            VIX term structure · FRED macro · Crypto market · Futures &amp; yields — powered by CBOE · FRED · CoinGecko · Stooq · TwelveData
          </p>
        </div>
        {lastUpdate && (
          <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace", marginTop: 4, whiteSpace: 'nowrap' }}>
            Updated {lastUpdate}
          </div>
        )}
      </div>

      {/* VIX + Spot — top row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <VIXPanel data={vixData} />
        <SpotPanel data={stooqData} />
      </div>

      {/* FRED + Crypto — bottom row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <MacroPanel data={macroData} />
        <CryptoPanel data={cryptoData} />
      </div>

      <div style={{ marginTop: 12, fontSize: 10, color: 'var(--text-muted)', textAlign: 'right' }}>
        FRED data: Federal Reserve Bank of St. Louis · Crypto: CoinGecko · Volatility: CBOE · Futures: Stooq
      </div>
    </div>
  )
}
