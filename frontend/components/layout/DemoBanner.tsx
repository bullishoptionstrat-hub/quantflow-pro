'use client'

import { useEffect, useState } from 'react'
import { DEMO_COOKIE, isDemoModeEnabled } from '@/lib/demo'

/**
 * Persistent, non-dismissible marker that this session is a demo.
 *
 * Deliberately loud. The terminal is styled to look like a live institutional
 * flow product, and a demo session is showing simulated prints — a subtle badge
 * would let someone screenshot this and present it as a live feed. It is not
 * dismissible for the same reason.
 *
 * The cookie is httpOnly so this cannot read it; presence is inferred from the
 * fact that the app rendered at all without a Supabase session, which is only
 * possible in demo mode (`middleware.ts` redirects otherwise).
 */
export function DemoBanner() {
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (!isDemoModeEnabled()) return
    let cancelled = false
    // A real session outranks the banner: only show it when there is none.
    import('@/lib/supabase').then(async ({ supabase }) => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!cancelled) setShow(!session)
    })
    return () => { cancelled = true }
  }, [])

  if (!show) return null

  return (
    <div
      role="status"
      className="w-full bg-amber-500 text-black font-mono text-xs font-semibold tracking-wide px-4 py-2 flex items-center justify-center gap-2 border-b border-amber-600"
    >
      <span className="uppercase">Demo mode</span>
      <span className="opacity-80">
        · Simulated data, not a live market feed · Not investment advice
      </span>
      <a href="/login" className="underline underline-offset-2 hover:opacity-70">
        Sign in
      </a>
    </div>
  )
}

export { DEMO_COOKIE }
