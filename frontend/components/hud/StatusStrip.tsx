'use client'
import { useEffect, useState } from 'react'
import { useStore } from '@/store/useStore'
import { describeSession, useMarketSession, SESSION_TONE } from '@/lib/marketSession'
import { syntheticShare } from '@/lib/syntheticShare'
import { SourceStatus } from '@/components/layout/SourceStatus'
import { openPalette } from './CommandPalette'

/**
 * The desk's status strip. Everything on it is something the terminal already
 * measured, shown once more where the eye lands first:
 *
 *   - three wall clocks, each with an explicit IANA zone. They are local time
 *     and nothing else — no word about whether anything is trading, and no
 *     colour change by hour, because a clock that turned green at 09:30 would
 *     be a second session calendar, and the one calendar lives in the backend;
 *   - the RTH verdict, worded by `describeSession` from the shared
 *     `/api/health` poll — the same label the sidebar prints, from the same
 *     response;
 *   - the socket's transport state, which is transport and not a claim about
 *     the data;
 *   - the constructed-print share, from the `synthetic` flag on each print;
 *   - the source summary, from the same health response.
 *
 * Nothing else. No latency, no ping, no uptime, no throughput: the terminal
 * does not measure them, and a number on a status strip that measures nothing
 * is exactly the decoration this codebase keeps deleting. `hud.test.tsx`
 * fails on any digit here outside the clocks while nothing has reported.
 */

export const CLOCKS = [
  { code: 'NY', timeZone: 'America/New_York' },
  { code: 'LDN', timeZone: 'Europe/London' },
  { code: 'TYO', timeZone: 'Asia/Tokyo' },
] as const

const formatters = new Map<string, Intl.DateTimeFormat>()

/** `hh:mm:ss` (24-hour) in `timeZone`. */
export function zoneClock(at: Date, timeZone: string): string {
  let f = formatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    })
    formatters.set(timeZone, f)
  }
  return f.format(at)
}

export function StatusStrip() {
  const { connected, flowEvents } = useStore()
  const { panel, sources } = useMarketSession()
  const session = describeSession(panel.status === 'ok' ? panel.data : null)
  const tone = SESSION_TONE[session.tone]
  const share = syntheticShare(flowEvents)

  // Null until mounted: the server's clock and the browser's differ by the
  // render time, and a mismatch would be a hydration error. The placeholder is
  // dashes, not a time.
  const [now, setNow] = useState<Date | null>(null)
  useEffect(() => {
    const tick = () => setNow(new Date())
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="hud-strip" role="region" aria-label="Desk status">
      <div className="hud-strip__clocks" role="group" data-testid="hud-clocks"
        aria-label="World clocks — local time only, not session status">
        {CLOCKS.map((c) => (
          <span key={c.code} className="hud-strip__clock" title={c.timeZone}>
            <span className="hud-strip__key">{c.code}</span>
            <time className="hud-strip__time">{now ? zoneClock(now, c.timeZone) : '--:--:--'}</time>
          </span>
        ))}
      </div>

      <span className="hud-strip__sep" aria-hidden="true" />

      <span className="hud-strip__item" data-testid="hud-session" title={session.detail}>
        <span className="hud-dot" style={{ background: tone }} aria-hidden="true" />
        <span style={{ color: tone, fontWeight: 600 }}>{session.label}</span>
      </span>

      <span className="hud-strip__item hud-strip__feed" data-testid="hud-feed"
        title="The socket's transport state. It says whether prints can arrive, not whether they are observed.">
        <span className="hud-dot" style={{ background: connected ? '#22c55e' : '#f97316' }} aria-hidden="true" />
        <span style={{ color: connected ? '#86efac' : '#fdba74' }}>
          {connected ? 'FEED CONNECTED' : 'FEED DISCONNECTED'}
        </span>
      </span>

      {share !== null && (
        <span className="hud-strip__item hud-strip__wide" data-testid="hud-constructed"
          title="Prints flagged synthetic: constructed from aggregate volume or generated, not observed.">
          <span className="hud-dot" style={{ background: '#fbbf24' }} aria-hidden="true" />
          <span style={{ color: '#fbbf24' }}>SYN · {share}</span>
        </span>
      )}

      <span className="hud-strip__sources hud-strip__wide">
        <SourceStatus panel={sources} size="strip" />
      </span>

      <span className="hud-strip__spacer" />

      <button type="button" className="hud-strip__jump" onClick={openPalette}
        aria-keyshortcuts="Control+K Meta+K" title="Jump to a page (Ctrl+K or ⌘K)">
        <kbd>⌘K</kbd> / <kbd>Ctrl K</kbd> · JUMP
      </button>
    </div>
  )
}
