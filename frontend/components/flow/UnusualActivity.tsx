'use client'
import { useState, useEffect } from 'react'
import { apiFetch } from '@/lib/apiFetch'

interface UnusualContract {
  symbol: string
  expiry: string
  strike: number
  right: 'C' | 'P'
  volume: number
  openInterest: number
  volumeToOI: number
  last: number
  iv: number
  notional: number
  delayedMinutes: number
  /** null when the payload carried no timestamp — see tradeDateInferred. */
  asOf: string | null
  /** True when asOf could not be established; the panel must not imply currency. */
  tradeDateInferred?: boolean
}

const fmtNotional = (n: number) =>
  n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${(n / 1e3).toFixed(0)}K`

const mono = "'JetBrains Mono', monospace"

export function UnusualActivity() {
  const [rows, setRows] = useState<UnusualContract[]>([])
  const [asOf, setAsOf] = useState<string | null>(null)
  const [dateInferred, setDateInferred] = useState(false)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    async function load() {
      try {
        const res = await apiFetch('/api/flow/unusual?limit=15')
        if (!res.ok) throw new Error(String(res.status))
        const j = await res.json()
        if (!alive) return
        setRows(Array.isArray(j.contracts) ? j.contracts : [])
        setAsOf(j.contracts?.[0]?.asOf ?? null)
        setDateInferred(Boolean(j.contracts?.[0]?.tradeDateInferred))
        setFailed(false)
      } catch {
        // Show nothing rather than stale or invented rows.
        if (alive) setFailed(true)
      } finally {
        if (alive) setLoading(false)
      }
    }
    load()
    const t = setInterval(load, 60_000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  const th = { fontSize: 9, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.1em', textTransform: 'uppercase' as const, textAlign: 'left' as const, padding: '0 10px 8px 0' }
  const td = { fontSize: 12, fontFamily: mono, padding: '7px 10px 7px 0', borderTop: '1px solid rgba(255,255,255,0.05)' }

  return (
    <div className="card" style={{ padding: '14px 16px', marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#fafafa' }}>🏛️ Unusual Options Activity</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
            Volume exceeding open interest — positions being opened, not closed. Ranked by notional.
          </div>
        </div>
        {/* Provenance stated on the panel itself: this is a delayed daily
            aggregate, and must never read as the live tape beside it. */}
        <div style={{ fontSize: 10, color: '#fbbf24', fontFamily: mono, textAlign: 'right' }}>
          CBOE · {dateInferred || !asOf ? 'AGE UNKNOWN' : '~15 MIN DELAYED'}
          <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>
            daily volume aggregate, not a tape
            {asOf && !dateInferred
              ? ` · as of ${asOf.slice(11, 16)}`
              : ' · source gave no timestamp, age not established'}
          </div>
        </div>
      </div>

      {loading ? (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '12px 0' }}>Loading chains…</div>
      ) : failed ? (
        <div style={{ fontSize: 12, color: '#ef4444', padding: '12px 0' }}>Unable to load CBOE chains right now.</div>
      ) : rows.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '12px 0' }}>No contracts above the volume/OI threshold yet.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
            <thead>
              <tr>
                {['Symbol', 'Type', 'Strike', 'Expiry', 'Volume', 'Open Int', 'Vol/OI', 'IV', 'Notional'].map(h => (
                  <th key={h} style={th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const isCall = r.right === 'C'
                const color = isCall ? '#22c55e' : '#ef4444'
                return (
                  <tr key={`${r.symbol}-${r.strike}-${r.right}-${r.expiry}-${i}`}>
                    <td style={{ ...td, color: '#fafafa', fontWeight: 700 }}>{r.symbol}</td>
                    <td style={{ ...td, color, fontWeight: 700 }}>{isCall ? 'CALL' : 'PUT'}</td>
                    <td style={{ ...td, color: '#fafafa' }}>{r.strike}</td>
                    <td style={{ ...td, color: 'var(--text-muted)' }}>{r.expiry}</td>
                    <td style={{ ...td, color: '#fafafa' }}>{r.volume.toLocaleString()}</td>
                    <td style={{ ...td, color: 'var(--text-muted)' }}>{r.openInterest.toLocaleString()}</td>
                    <td style={{ ...td, color: r.volumeToOI >= 5 ? '#a78bfa' : '#fafafa', fontWeight: 700 }}>
                      {Number.isFinite(r.volumeToOI) ? `${r.volumeToOI.toFixed(1)}x` : 'new'}
                    </td>
                    <td style={{ ...td, color: 'var(--text-muted)' }}>{r.iv ? `${(r.iv * 100).toFixed(0)}%` : '—'}</td>
                    <td style={{ ...td, color: '#fbbf24', fontWeight: 700 }}>{fmtNotional(r.notional)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
