'use client'
import { useState, useEffect, useCallback } from 'react'
import { usePathname } from 'next/navigation'
import { useStore } from '@/store/useStore'
import { apiFetch } from '@/lib/apiFetch'
import { formatPremium } from '@/lib/utils'
import { pctColor, spotPrice, signedPct } from '@/lib/format'
import { POLL_MS, STALE_MS } from '@/lib/spotQuotes'
import type { SpotQuote } from '@/lib/types'

/**
 * The ticker tape reads `/api/macro/quotes`; it used to make the prices up.
 *
 * `generateQuotes()` held a hardcoded base map — SPX 5587, NVDA 942, TSLA 182,
 * all 2024 levels — added `Math.random() * 4 - 1.5` to each, and re-rolled the
 * whole board on a `Math.random() > 0.7` coin flip every ten seconds. The
 * result rendered in the same monospace, in the same green and red, in the
 * same strip, as everything else on the screen. This component is mounted in
 * `app/layout.tsx`, so those numbers sat above the fold of **every page** in
 * the terminal, including the ones whose own fabricators have already been
 * removed: a reader who had just been told the GEX chart draws nothing without
 * a real chain was still being shown an invented NVDA print two inches higher.
 *
 * Same class as the seeded flow feed, the random dark-pool prints and the
 * coin-flipped support/resistance levels — and the most visible instance left,
 * because it is on screen no matter which page you are on.
 *
 * The symbols now come from the response rather than a `TICKERS` const. The
 * old list held fifteen; TwelveData's `WATCHED` holds ten, overlapping on
 * eight, so seven of the tape's tickers could never have had a live price
 * behind them. A hand-maintained list in front of a feed that does not cover
 * it is the same defect the settings page retired three lists over.
 */

// The poll interval and the staleness threshold live in `lib/spotQuotes.ts`
// with the feed itself. They were declared here first; the watchlist and the
// strategy builder read the same board and need the same rule, and a second
// copy of "five minutes" is a second copy to keep correct — the finding that
// retired three hand-maintained lists from the settings page.

type Tape =
  /** Nothing fetched yet. Renders empty rather than guessing. */
  | { status: 'loading' }
  /** The backend refused us — no session, or demo mode is off. */
  | { status: 'unauthorized' }
  /** We reached the backend. `quotes` may still be empty. */
  | { status: 'ok'; quotes: SpotQuote[] }
  /** We did not reach the backend. */
  | { status: 'unreachable' }

export function TopBar() {
  const [tape, setTape] = useState<Tape>({ status: 'loading' })
  const [time, setTime] = useState<string>('')
  const { powerAlerts, flowEvents } = useStore()
  const pathname = usePathname()
  const newAlerts = powerAlerts.filter(a => Date.now() - new Date(a.created_at).getTime() < 300_000).length
  const totalPremium = flowEvents.reduce((s, e) => s + e.total_premium, 0)

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/macro/quotes')
      if (res.status === 401 || res.status === 403) {
        // The tape is mounted on `/login` too. Signed out is not an error
        // worth a banner — it renders as an empty strip, and the next poll
        // picks the quotes up once there is a session.
        setTape({ status: 'unauthorized' })
        return
      }
      if (!res.ok) { setTape({ status: 'unreachable' }); return }
      const body = await res.json()
      setTape({ status: 'ok', quotes: Array.isArray(body?.quotes) ? body.quotes : [] })
    } catch {
      setTape({ status: 'unreachable' })
    }
  }, [])

  useEffect(() => {
    const tick = () => {
      setTime(new Date().toLocaleTimeString('en-US', { hour12: false, timeZone: 'America/New_York' }))
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    // Refetch on navigation as well as on the timer: signing in is a
    // `router.push`, not a reload, so this component stays mounted across it
    // and would otherwise show an empty tape until the next poll came round.
    load()
    const id = setInterval(load, POLL_MS)
    return () => clearInterval(id)
  }, [load, pathname])

  const quotes = tape.status === 'ok' ? tape.quotes : []
  const newest = quotes.reduce((m, q) => Math.max(m, q.timestamp ?? 0), 0)
  const stale = quotes.length > 0 && newest > 0 && Date.now() - newest > STALE_MS

  return (
    <div className="topbar" style={{ justifyContent: 'space-between' }}>
      {/* Scrolling ticker */}
      <div style={{ flex: 1, overflow: 'hidden', maskImage: 'linear-gradient(90deg,transparent,black 40px,black calc(100% - 40px),transparent)' }}>
        <div style={{ display: 'flex', gap: 24, alignItems: 'center', overflowX: 'auto', scrollbarWidth: 'none' }}>
          {stale && (
            <span style={{ color: 'var(--text-muted)', fontSize: 11, whiteSpace: 'nowrap', fontFamily: "'JetBrains Mono', monospace" }}>
              AS OF {new Date(newest).toLocaleTimeString('en-US', { hour12: false, timeZone: 'America/New_York' })} ET
            </span>
          )}
          {quotes.map(q => (
            <span key={q.symbol} style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', fontFamily: "'JetBrains Mono', monospace", fontSize: 12, opacity: stale ? 0.6 : 1 }}>
              <span style={{ color: '#a78bfa', fontWeight: 600 }}>{q.symbol}</span>
              <span style={{ color: '#fafafa' }}>${spotPrice(q.price)}</span>
              <span style={{ color: pctColor(q.changePct) }}>{signedPct(q.changePct)}</span>
            </span>
          ))}
          {/* An unavailable tape says so once, quietly, and names no fix: the
              per-source status and the variable that turns a connector on live
              on the settings page, and a second copy of that explanation here
              would be a second copy to keep correct. */}
          {tape.status === 'ok' && quotes.length === 0 && (
            <span style={{ color: 'var(--text-muted)', fontSize: 11, whiteSpace: 'nowrap', fontFamily: "'JetBrains Mono', monospace" }}>
              NO SPOT FEED REPORTING — see Settings for source status
            </span>
          )}
          {tape.status === 'unreachable' && (
            <span style={{ color: 'var(--text-muted)', fontSize: 11, whiteSpace: 'nowrap', fontFamily: "'JetBrains Mono', monospace" }}>
              SPOT FEED UNREACHABLE — the backend did not answer
            </span>
          )}
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
