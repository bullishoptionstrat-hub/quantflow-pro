'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useMarketSession, describeSession, SESSION_TONE } from '@/lib/marketSession'
import { NAV, NAV_GROUPS, isActive } from '@/lib/nav'
import { syntheticShare as constructedShare } from '@/lib/syntheticShare'
import { useStore } from '@/store/useStore'
import { SignOutButton } from './SignOutButton'
import { SourceStatus } from './SourceStatus'

// The page list lives in `lib/nav.ts` so the sidebar, the mobile bar and the
// command palette cannot disagree about which pages exist. There is still no
// static `LIVE` badge on any entry: it sat two lines under the connection dot
// and contradicted it whenever the socket was down.

export function Sidebar() {
  const pathname = usePathname()
  const { powerAlerts, connected, flowEvents } = useStore()
  const { panel: sessionPanel, sources: sourcesPanel } = useMarketSession()
  const session = describeSession(
    sessionPanel.status === 'ok' ? sessionPanel.data : null,
  )
  const TONE = SESSION_TONE
  const tone = TONE[session.tone]

  // How much of what has arrived is constructed rather than observed — per
  // print, from `synthetic`. The wording rule ("CONSTRUCTED", never
  // "SIMULATED") lives with the helper, shared with the status strip.
  const syntheticShare = constructedShare(flowEvents)
  const newAlerts = powerAlerts.filter(a => {
    const d = new Date(a.created_at)
    return Date.now() - d.getTime() < 300_000
  }).length

  return (
    <aside className="sidebar">
      {/* Logo */}
      <div className="sidebar__brand">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
            <rect x="0.5" y="0.5" width="27" height="27" rx="3" fill="#0c1220" stroke="rgba(34,211,238,0.45)"/>
            <path d="M6 20L11 13L15 16L20 8" stroke="#a78bfa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <circle cx="20" cy="8" r="2" fill="#22d3ee"/>
          </svg>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '0.02em' }}>QuantFlow Pro</div>
            <div style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', letterSpacing: '0.1em' }}>QUANTUM EDGE CAPITAL</div>
          </div>
        </div>
      </div>

      {/* Market status */}
      <div className="sidebar__system">
        <div className="sidebar__system-title">SYSTEM</div>
        {/* This was a weekday-and-clock check computed in the browser, with no
            holiday calendar behind it — green on Thanksgiving, and green all
            afternoon on a 13:00 half-day. The verdict now comes from the
            published calendar via `/api/health`, and the three tones are three
            different facts: open, established closed, and cannot say. A
            published closure is painted grey-red rather than alarm-red because
            Sunday is not a fault, and `SESSION UNKNOWN` is never painted as
            closed — the calendar refusing to answer is the one case where the
            terminal genuinely does not know. Every label names RTH: the
            verdict is the exchange's regular session and nothing wider, so it
            may not be printed as "the market". */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}
          title={session.detail}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: tone, display: 'inline-block', boxShadow: session.tone === 'open' ? '0 0 0 2px rgba(34,197,94,0.3)' : 'none' }} />
          <span style={{ color: tone, fontWeight: 600, fontFamily: "'JetBrains Mono', monospace" }}>
            {session.label}
          </span>
        </div>

        {/*
          This read `connected ? '● LIVE DATA' : '◌ SIMULATION'`, and it was
          wrong in both directions.

          `connected` is the socket's transport state. On a keyless deployment
          the backend simulates prints and sends them down a perfectly healthy
          socket, so the sidebar said LIVE DATA over a simulated tape. And
          nothing in the browser simulates anything any more — `generateSeedFlow`
          is deleted — so a dead socket said SIMULATION while no data existed at
          all. One flag was being asked two questions.

          Transport is transport; whether a print is constructed is per print,
          and the wire has carried `synthetic` all along.
        */}
        <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: connected ? '#22c55e' : '#f97316', display: 'inline-block' }} />
          <span style={{ color: connected ? '#86efac' : '#fdba74', fontFamily: "'JetBrains Mono', monospace" }}>
            {connected ? '● FEED CONNECTED' : '◌ FEED DISCONNECTED'}
          </span>
        </div>
        {syntheticShare !== null && (
          <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#fbbf24', display: 'inline-block' }} />
            <span style={{ color: '#fbbf24', fontFamily: "'JetBrains Mono', monospace" }}>
              SYN · {syntheticShare}
            </span>
          </div>
        )}
      </div>

      {/* Nav — grouped, from the one page list in lib/nav.ts */}
      <nav aria-label="Pages" style={{ flex: 1, padding: '4px 0', overflowY: 'auto' }}>
        {NAV_GROUPS.map(group => {
          const items = NAV.filter(n => n.group === group.id)
          return (
            <div key={group.id}>
              <div className="nav-group">{group.label}</div>
              {items.map(item => {
                const active = isActive(pathname, item.href)
                const showAlertBadge = item.href === '/power-alerts' && newAlerts > 0

                return (
                  <Link key={item.href} href={item.href} className={`nav-item ${active ? 'active' : ''}`}
                    aria-current={active ? 'page' : undefined}>
                    <span style={{ fontSize: 14, width: 20, textAlign: 'center', flexShrink: 0 }} aria-hidden="true">{item.icon}</span>
                    <span style={{ flex: 1 }}>{item.label}</span>

                    {/* Power alerts count badge */}
                    {showAlertBadge && (
                      <span style={{ background: '#ef4444', color: '#fff', fontSize: 10, fontWeight: 700, borderRadius: 10, padding: '1px 6px', fontFamily: "'JetBrains Mono', monospace" }}>
                        {newAlerts}
                      </span>
                    )}

                    {/* "NEW" badge for recently added pages */}
                    {item.badge === 'NEW' && !showAlertBadge && (
                      <span style={{ background: 'rgba(251,191,36,0.12)', color: '#fbbf24', fontSize: 9, fontWeight: 700, borderRadius: 2, padding: '1px 5px', fontFamily: "'JetBrains Mono', monospace" }}>
                        NEW
                      </span>
                    )}

                    {/* A `LIVE` / `OFF` pill used to render here. It was
                        driven by `isMarketOpen()`, so it said LIVE on any
                        weekday afternoon whether or not a single signal had
                        arrived — and it sat two lines below the connection
                        dot, contradicting it whenever the socket was down.
                        Nothing replaces it: the dot above already answers
                        this, once. */}
                  </Link>
                )
              })}
            </div>
          )
        })}
      </nav>

      {/* Bottom */}
      <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)' }}>
        <SignOutButton />
        {/* These were six hardcoded green tags (CBOE, FRED, CRYPTO, REDDIT,
            NEWS, STOOQ) shown whatever the backend said. The counts now come
            from /api/health on the request this sidebar already makes. */}
        <SourceStatus panel={sourcesPanel} />
        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>QUANTUM EDGE CAPITAL LLC</div>
        <div style={{ marginTop: 2, fontSize: 9, color: 'var(--text-muted)' }}>Not investment advice</div>
      </div>
    </aside>
  )
}
