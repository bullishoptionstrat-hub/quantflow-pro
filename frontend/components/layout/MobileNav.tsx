'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

const ITEMS = [
  { href: '/flow',         icon: '⚡', label: 'Flow' },
  { href: '/power-alerts', icon: '🔥', label: 'Alerts' },
  { href: '/gex',          icon: 'Γ',  label: 'GEX' },
  { href: '/calculator',   icon: '🧮', label: 'Calc' },
  { href: '/watchlist',    icon: '★',  label: 'Watch' },
]

export function MobileNav() {
  const pathname = usePathname()
  return (
    <nav className="mobile-nav">
      {ITEMS.map(item => {
        const active = pathname === item.href
        return (
          <Link key={item.href} href={item.href} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '4px 12px', color: active ? '#a78bfa' : 'var(--text-secondary)', textDecoration: 'none' }}>
            <span style={{ fontSize: 18 }}>{item.icon}</span>
            <span style={{ fontSize: 10, fontWeight: active ? 600 : 400 }}>{item.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}
