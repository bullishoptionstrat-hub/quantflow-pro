'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { isMarketOpen } from '@/lib/utils'
import { useStore } from '@/store/useStore'

const NAV = [
  { href: '/flow',          icon: '⚡', label: 'Live Flow',      badge: 'LIVE', group: 'flow' },
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
  const { powerAlerts, connected } = useStore()
  const open = isMarketOpen()
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: open ? '#22c55e' : '#ef4444', display: 'inline-block', boxShadow: open ? '0 0 0 2px rgba(34,197,94,0.3)' : 'none' }} />
          <span style={{ color: open ? '#22c55e' : '#ef4444', fontWeight: 600, fontFamily: "'JetBrains Mono', monospace" }}>
            {open ? 'MARKET OPEN' : 'MARKET CLOSED'}
          </span>
        </div>
        <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: connected ? '#22c55e' : '#f97316', display: 'inline-block' }} />
          <span style={{ color: connected ? '#86efac' : '#fdba74', fontFamily: "'JetBrains Mono', monospace" }}>
            {connected ? '● LIVE DATA' : '◌ SIMULATION'}
          </span>
        </div>
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

                    {/* LIVE badge */}
                    {item.badge === 'LIVE' && !showAlertBadge && (
                      <span style={{
                        background: open ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)',
                        color: open ? '#86efac' : '#fca5a5',
                        fontSize: 9, fontWeight: 700, borderRadius: 3, padding: '1px 5px', fontFamily: "'JetBrains Mono', monospace"
                      }}>
                        {open ? 'LIVE' : 'OFF'}
                      </span>
                    )}
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
