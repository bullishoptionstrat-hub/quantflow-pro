'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { isRegularHours } from '@/lib/utils'
import { useStore } from '@/store/useStore'

const NAV = [
  // No static `LIVE` badge: it sat two lines under the connection dot and
  // contradicted it whenever the socket was down.
  { href: '/flow',          icon: '⚡', label: 'Live Flow',      badge: null,   group: 'flow' },
  { href: '/dark-pool',     icon: '🌑', label: 'Dark Pool',      badge: null,   group: 'flow' },
  { href: '/power-alerts',  icon: '🔥', label: 'Power Alerts',   badge: null,   group: 'flow' },
  { href: '/heat-map',      icon: '🗺', label: 'Heat Map',       badge: null,   group: 'flow' },
  { href: '/gex',           icon: 'Γ',  label: 'GEX Levels',     badge: null,   group: 'analytics' },
  { href: '/macro',         icon: '📊', label: 'Macro',          badge: 'NEW',  group: 'analytics' },
  { href: '/news',          icon: '📰', label: 'News & Sentiment', badge: 'NEW', group: 'analytics' },
  { href: '/calculator',    icon: '🧮', label: 'P/L Calculator', badge: null,   group: 'tools' },
  { href: '/optimizer',     icon: '⚙', label: 'Optimizer',      badge: null,   group: 'tools' },
  { href: '/watchlist',     icon: '★',  label: 'Watchlist',      badge: null,   group: 'tools' },
  { href: '/settings',      icon: '⚙', label: 'Settings',       badge: null,   group: 'tools' },
]

const GROUP_LABELS: Record<string, string> = {
  flow: 'FLOW',
  analytics: 'ANALYTICS',
  tools: 'TOOLS',
}

export function Sidebar() {
  const pathname = usePathname()
  const { powerAlerts, connected, flowEvents } = useStore()
  const regularHours = isRegularHours()

  // How much of what has arrived is constructed rather than observed. Shown
  // only when there is some, so a fully live feed stays quiet.
  const syntheticCount = flowEvents.filter(e => e.synthetic).length
  const syntheticShare = syntheticCount === 0
    ? null
    : syntheticCount === flowEvents.length
      ? 'ALL SIGNALS SIMULATED'
      : `${syntheticCount}/${flowEvents.length} SIMULATED`
  const newAlerts = powerAlerts.filter(a => {
    const d = new Date(a.created_at)
    return Date.now() - d.getTime() < 300_000
  }).length

  // Group nav items
  const groups = ['flow', 'analytics', 'tools']

  return (
    <aside className="sidebar">
      {/* Logo */}
      <div style={{ padding: '16px 16px 12px', borderBottom: '1px solid var(--border)', marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
            <rect width="28" height="28" rx="6" fill="#8b5cf6" fillOpacity=".2"/>
            <path d="M6 20L11 13L15 16L20 8" stroke="#a78bfa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <circle cx="20" cy="8" r="2" fill="#fbbf24"/>
          </svg>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#fafafa', letterSpacing: '-0.01em' }}>QuantFlow Pro</div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>QUANTUM EDGE CAPITAL</div>
          </div>
        </div>
      </div>

      {/* Market status */}
      <div style={{ padding: '8px 16px', marginBottom: 4 }}>
        {/* `MARKET OPEN` over a weekday-and-clock check, with no holiday
            calendar behind it — green on Thanksgiving. Named for what it
            knows: the session window, in New York. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}
          title="Weekday 09:30–16:00 ET. Market holidays are not checked.">
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: regularHours ? '#22c55e' : '#ef4444', display: 'inline-block', boxShadow: regularHours ? '0 0 0 2px rgba(34,197,94,0.3)' : 'none' }} />
          <span style={{ color: regularHours ? '#22c55e' : '#ef4444', fontWeight: 600, fontFamily: "'JetBrains Mono', monospace" }}>
            {regularHours ? 'REGULAR HOURS' : 'OUTSIDE HOURS'}
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
              🧪 {syntheticShare}
            </span>
          </div>
        )}
      </div>

      {/* Nav — grouped */}
      <nav style={{ flex: 1, padding: '4px 0', overflowY: 'auto' }}>
        {groups.map(group => {
          const items = NAV.filter(n => n.group === group)
          return (
            <div key={group}>
              <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', padding: '10px 16px 4px', letterSpacing: '0.1em', fontFamily: "'JetBrains Mono', monospace" }}>
                {GROUP_LABELS[group]}
              </div>
              {items.map(item => {
                const isActive = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href))
                const showAlertBadge = item.href === '/power-alerts' && newAlerts > 0

                return (
                  <Link key={item.href} href={item.href} className={`nav-item ${isActive ? 'active' : ''}`}>
                    <span style={{ fontSize: 14, width: 20, textAlign: 'center', flexShrink: 0 }}>{item.icon}</span>
                    <span style={{ flex: 1 }}>{item.label}</span>

                    {/* Power alerts count badge */}
                    {showAlertBadge && (
                      <span style={{ background: '#ef4444', color: '#fff', fontSize: 10, fontWeight: 700, borderRadius: 10, padding: '1px 6px', fontFamily: "'JetBrains Mono', monospace" }}>
                        {newAlerts}
                      </span>
                    )}

                    {/* "NEW" badge for macro/news */}
                    {item.badge === 'NEW' && !showAlertBadge && (
                      <span style={{ background: 'rgba(251,191,36,0.15)', color: '#fbbf24', fontSize: 9, fontWeight: 700, borderRadius: 3, padding: '1px 5px', fontFamily: "'JetBrains Mono', monospace" }}>
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
        {/* 13 sources indicator */}
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
          {['CBOE','FRED','CRYPTO','REDDIT','NEWS','STOOQ'].map(s => (
            <span key={s} style={{ fontSize: 8, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, background: 'rgba(34,197,94,0.1)', color: '#86efac', borderRadius: 2, padding: '1px 4px' }}>
              {s}
            </span>
          ))}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>QUANTUM EDGE CAPITAL LLC</div>
        <div style={{ marginTop: 2, fontSize: 9, color: 'var(--text-muted)' }}>Not investment advice</div>
      </div>
    </aside>
  )
}
