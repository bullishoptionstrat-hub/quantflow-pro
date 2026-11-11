'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { NAV, isActive } from '@/lib/nav'
import { SignOutButton } from './SignOutButton'

// The mobile bar shows the pages that carry a `short` label in `lib/nav.ts`,
// in the same order as the sidebar. It used to hold its own list.
const ITEMS = NAV.filter((n) => n.short)

export function MobileNav() {
  const pathname = usePathname()
  return (
    <nav className="mobile-nav" aria-label="Pages">
      {ITEMS.map(item => {
        const active = isActive(pathname, item.href)
        return (
          <Link key={item.href} href={item.href} aria-current={active ? 'page' : undefined}
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '4px 12px', color: active ? 'var(--accent-cyan)' : 'var(--text-secondary)', textDecoration: 'none' }}>
            <span style={{ fontSize: 18 }} aria-hidden="true">{item.icon}</span>
            <span style={{ fontSize: 10, fontWeight: active ? 600 : 400 }}>{item.short}</span>
          </Link>
        )
      })}
      <SignOutButton variant="mobile" />
    </nav>
  )
}
