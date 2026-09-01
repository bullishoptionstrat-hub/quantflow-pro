'use client'
import { useState, useEffect } from 'react'
import { apiFetch } from '@/lib/apiFetch'

// ─── Types ───────────────────────────────────────────────────────────────────
/**
 * `GET /api/macro/vix`. Field names are the route's, not invented here.
 *
 * Three of these were wrong and all three failed silently. `timestamp` does
 * not exist — the route sends `updatedAt`, so the panel header ran
 * `new Date(undefined).toLocaleTimeString()` and rendered **"Invalid Date"**
 * whenever the data was real, showing a valid clock only while the synthetic
 * fallback was up. `pcr`/`pcrIndex` do not exist either; the route sends the
 * connector's names, so both ratios read "—" forever and the ">1 is bearish"
 * colouring resolved green off `undefined ?? 0`. `vxn` was never sent by
 * anything, and now is.
 */
interface VIXData {
  vix9d?: number
  vix: number
  vix3m?: number
  vix6m?: number
  vix1y?: number
  vxn?: number
  /** Null when Cboe's statistics endpoint refuses. Null is not zero. */
  putCallRatioEquity?: number | null
  putCallRatioIndex?: number | null
  /** Present only when the put/call block is unavailable, and says why. */
  putCallUnavailable?: string
  updatedAt: string
}
interface MacroSeries {
  id: string
  label: string
  value: number
  previousValue?: number
  unit: string
  lastUpdated: string
}
/**
 * `GET /api/macro/crypto` → `quotes`.
 *
 * Two errors here, and the fabricated fallback hid both. The page tested the
 * response with `Array.isArray(cryptoRes.value)` against a body shaped
 * `{ quotes, global }`, so `setCryptoData` never fired and CoinGecko's live
 * quotes were dropped on the floor — the same mistake, on a third endpoint.
 * And `change24h` on the wire is the absolute move (`64.88`), not the percent
 * (`0.40`), while the table renders it as `{...}%`. Reading the response
 * correctly without fixing the field would have printed BTC "+64.88%" on a
 * 0.4% day.
 */
interface CryptoQuote {
  symbol: string
  name: string
  price: number
  changePct24h: number
  marketCap: number
  volume24h: number
}
/**
 * `GET /api/macro` → `futures` / `indices` / `yields`.
 *
 * This interface used to declare `{ symbol, price, change, changePct }`, and
 * the wire carried a daily OHLC bar with none of `price`, `change` or
 * `changePct` on it — so `q.price.toFixed(2)` would have thrown the moment
 * real data arrived. It never arrived: the page read this off
 * `/api/macro/quotes` (which is TwelveData spot, not Stooq) and then discarded
 * the response with an `Array.isArray` check that a `{ quotes: [...] }` object
 * could never pass. Two bugs cancelling into a silent empty panel.
 *
 * `sessionChange` is close against the same bar's open, and is named that way
 * because it is not the day-over-day move a "+0.21%" usually claims.
 */
interface StooqQuote {
  symbol: string
  price: number
  sessionChange: number
  sessionChangePct: number
  date: string
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
/**
 * What a panel shows when it has nothing.
 *
 * Each of the three panels below used to carry a `FALLBACK` array of
 * hardcoded numbers — Fed Funds at 5.33%, BTC at $67,420, ES at 5787.50 —
 * rendered through exactly the same markup as live data, with no marker of any
 * kind. Those are 2024 values on a terminal CLAUDE.md describes as "styled to
 * look like a live institutional product", and the VIX one was worse: it was
 * stamped with `timestamp: new Date()`, so invented numbers carried a fresh
 * clock while real ones rendered "Invalid Date".
 *
 * This is not the `synthetic: true` case. Simulated prints exist to keep the
 * terminal functional without vendor keys and are excluded from the track
 * record by name. A hardcoded Fed Funds rate has no such role and no such
 * exclusion — it is a number a reader would act on. Naming the missing source
 * is strictly more useful than showing a stale one.
 */
function EmptyState({ what, why }: { what: string; why?: string }) {
  return (
    <div style={{ padding: '28px 16px', textAlign: 'center', color: 'var(--text-muted)' }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>No {what} available</div>
      <div style={{ fontSize: 11, lineHeight: 1.6 }}>{why ?? 'The source has not reported yet.'}</div>
    </div>
  )
}

/**
 * A crypto price, at enough precision to be a price.
 *
 * The old rule was `toFixed(4)` below $1, which renders SHIB at 0.0000058 as
 * **$0.0000** — a live quote displayed as zero, which is the same defect as
 * the dead sources below, just arriving through the formatter. Sub-cent
 * assets get significant digits instead of fixed decimals.
 */
function cryptoPrice(v: number) {
  if (v >= 1) return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (v >= 0.01) return v.toFixed(4)
  if (!(v > 0)) return '0'
  // Four meaningful digits however small the number is, written out rather
  // than in exponent form, with the padding zeros trimmed back off.
  const places = Math.max(4, -Math.floor(Math.log10(v)) + 3)
  return v.toFixed(places).replace(/0+$/, '').replace(/\.$/, '')
}

/** Grey for a ratio we do not have. Absence is not a reading. */
function pcrColor(v: number | null | undefined) {
  if (v == null) return 'var(--text-muted)'
  return v > 1 ? '#ef4444' : '#22c55e'
}

// ─── VIX Term Structure ───────────────────────────────────────────────────────
function VIXPanel({ data }: { data: VIXData | null }) {
  const loading = !data
  const terms = [
    { label: 'VIX9D', value: data?.vix9d, desc: '9-Day' },
    { label: 'VIX', value: data?.vix, desc: '30-Day', main: true },
    { label: 'VIX3M', value: data?.vix3m, desc: '3-Month' },
    { label: 'VIX6M', value: data?.vix6m, desc: '6-Month' },
    { label: 'VIX1Y', value: data?.vix1y, desc: '1-Year' },
    { label: 'VXN', value: data?.vxn, desc: 'Nasdaq' },
  ]

  const maxVix = Math.max(...terms.map(t => t.value ?? 0), 1)

  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>📊 VIX TERM STRUCTURE</span>
        {data && (
          <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>
            {new Date(data.updatedAt).toLocaleTimeString()}
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
              {/*
                A missing ratio is grey and reads "n/a", not a green 0.00.
                `pcrColor` refuses to colour a value it does not have — the old
                `(undefined ?? 0) > 1` resolved green, so an unavailable ratio
                was rendered as a bullish one.
              */}
              <div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>EQUITY PCR</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: pcrColor(data?.putCallRatioEquity), fontFamily: "'JetBrains Mono', monospace" }}>
                  {data?.putCallRatioEquity?.toFixed(2) ?? 'n/a'}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>INDEX PCR</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: pcrColor(data?.putCallRatioIndex), fontFamily: "'JetBrains Mono', monospace" }}>
                  {data?.putCallRatioIndex?.toFixed(2) ?? 'n/a'}
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
            {data?.putCallUnavailable && (
              <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                Put/call ratios unavailable — {data.putCallUnavailable}
              </div>
            )}
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

  return (
    <div className="card">
      <div className="card-header">
        <span style={{ fontWeight: 700, fontSize: 13 }}>🏛 FRED MACRO INDICATORS</span>
      </div>
      {data.length === 0 ? (
        <EmptyState
          what="macro series"
          why="FRED needs an API key. Set FRED_API_KEY in the backend environment — it is free."
        />
      ) : (
      <div style={{ padding: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {data.map(s => {
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
      )}
    </div>
  )
}

// ─── Crypto Panel ─────────────────────────────────────────────────────────────
function CryptoPanel({ data }: { data: CryptoQuote[] }) {
  if (data.length === 0) {
    return (
      <div className="card">
        <div className="card-header">
          <span style={{ fontWeight: 700, fontSize: 13 }}>₿ CRYPTO MARKET</span>
        </div>
        <EmptyState what="crypto quotes" why="CoinGecko has not reported yet." />
      </div>
    )
  }

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
            {data.map(c => (
              <tr key={c.symbol} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <td style={{ padding: '8px 12px', fontWeight: 700 }}>
                  <span style={{ color: '#fbbf24' }}>{c.symbol}</span>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 6 }}>{c.name}</span>
                </td>
                <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>
                  ${cryptoPrice(c.price)}
                </td>
                <td style={{ padding: '8px 12px', textAlign: 'right', color: pctColor(c.changePct24h), fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 }}>
                  {c.changePct24h > 0 ? '+' : ''}{c.changePct24h.toFixed(2)}%
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
  // Keyed on the symbols the backend actually sends. These were Yahoo-style
  // tickers (`ES=F`, `^TNX`, `DX-Y.NYB`) and the wire carries Stooq's mapped
  // names, so every lookup missed and every tile fell back to printing its own
  // symbol twice.
  const LABEL_MAP: Record<string, string> = {
    SPX: 'S&P 500', NDX: 'Nasdaq 100', DJIA: 'Dow Jones', VIX: 'Volatility Index',
    TNX: '10Y Treasury', FVX: '5Y Treasury', TYX: '30Y Treasury',
    GOLD: 'Gold', SILVER: 'Silver', OIL: 'Crude Oil WTI', NATGAS: 'Natural Gas',
    DXY: 'US Dollar Index',
  }

  if (data.length === 0) {
    return (
      <div className="card">
        <div className="card-header">
          <span style={{ fontWeight: 700, fontSize: 13 }}>📡 FUTURES &amp; RATES (Stooq)</span>
        </div>
        <EmptyState
          what="futures or rates"
          why="Stooq is serving a browser-verification challenge instead of its CSV, so nothing is being cached. /api/health carries the detail."
        />
      </div>
    )
  }

  return (
    <div className="card">
      <div className="card-header">
        <span style={{ fontWeight: 700, fontSize: 13 }}>📡 FUTURES &amp; RATES (Stooq)</span>
      </div>
      <div style={{ padding: 8 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, padding: '0 8px 8px' }}>
          {data.map(q => (
            <div key={q.symbol} style={{ background: 'var(--bg-secondary)', borderRadius: 5, padding: '8px 10px', border: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#fafafa', fontFamily: "'JetBrains Mono', monospace" }}>{q.symbol}</div>
                <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 1 }}>{LABEL_MAP[q.symbol] ?? q.symbol}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>{q.price.toFixed(2)}</div>
                {/* Labelled "sess" because it is open→close on one bar, not the day-over-day move. */}
                <div style={{ fontSize: 10, color: pctColor(q.sessionChangePct), fontFamily: "'JetBrains Mono', monospace" }}>
                  {q.sessionChangePct > 0 ? '+' : ''}{q.sessionChangePct.toFixed(2)}% <span style={{ color: 'var(--text-muted)' }}>sess</span>
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
          apiFetch('/api/macro/vix').then(r => r.json()),
          apiFetch('/api/macro').then(r => r.json()),
          apiFetch('/api/macro/crypto').then(r => r.json()),
        ])

        // No synthetic fallback. This used to invent a whole term structure —
        // VIX 16.8, PCR 0.72 — and stamp it `timestamp: new Date()`, so the
        // panel showed a live-looking clock precisely when the numbers were
        // made up. `null` leaves the panel in its loading/empty state, which
        // is what "we do not have this" looks like.
        setVixData(
          vixRes.status === 'fulfilled' && vixRes.value?.vix != null
            ? vixRes.value
            : null,
        )

        if (macroRes.status === 'fulfilled' && Array.isArray(macroRes.value?.fred)) {
          setMacroData(macroRes.value.fred)
        }

        if (cryptoRes.status === 'fulfilled' && Array.isArray(cryptoRes.value?.quotes)) {
          setCryptoData(cryptoRes.value.quotes)
        }

        // Stooq comes off /api/macro, which this page already fetched above.
        //
        // It used to make a second request to /api/macro/quotes — which is
        // TwelveData spot prices, not Stooq — and then test the response with
        // `Array.isArray(q)` against a body shaped `{ quotes: [...] }`, so the
        // check could never pass and `setStooqData` never fired. The data it
        // wanted was already sitting in the /api/macro response it was reading
        // `.fred` out of and discarding the rest of.
        if (macroRes.status === 'fulfilled') {
          const m = macroRes.value
          const rows = [
            ...(Array.isArray(m?.indices) ? m.indices : []),
            ...(Array.isArray(m?.futures) ? m.futures : []),
            ...(Array.isArray(m?.yields) ? m.yields : []),
          ]
          setStooqData(rows)
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
