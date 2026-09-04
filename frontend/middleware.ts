import { createServerClient } from '@supabase/ssr'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { DEMO_COOKIE, isDemoModeEnabled } from '@/lib/demo'

/**
 * Whether this deployment can authenticate anyone at all.
 *
 * `createServerClient` **throws** when either value is missing — "Your
 * project's URL and Key are required to create a Supabase client!" — and it
 * was called unconditionally, before the demo check below. So a deployment
 * with no Supabase configuration returned a **500 on every gated route**,
 * including in demo mode, which exists precisely so the terminal works without
 * a session. The escape hatch was behind the door it was meant to open.
 *
 * Skipping the client when it cannot be built is not a weakening: with no
 * Supabase project there is no session to verify, so `user` is null either
 * way. Demo still needs both of its independent conditions.
 */
function supabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  )
}

export async function middleware(req: NextRequest) {
  const res = NextResponse.next()

  let user: { id: string } | null = null
  if (supabaseConfigured()) {
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return req.cookies.getAll()
          },
          setAll(cookiesToSet: { name: string; value: string; options: any }[]) {
            cookiesToSet.forEach(({ name, value, options }) => {
              res.cookies.set(name, value, options)
            })
          },
        },
      }
    )
    user = (await supabase.auth.getUser()).data.user
  }

  const isAuthRoute = req.nextUrl.pathname.startsWith('/login') || req.nextUrl.pathname.startsWith('/register')

  // A demo session is not a user. It is admitted to the app shell only, and only
  // when this deployment opted in — the cookie alone proves nothing if the build
  // has demo mode off, so both are required.
  const isDemo = isDemoModeEnabled() && req.cookies.get(DEMO_COOKIE)?.value === '1'

  // Everything the matcher lets through is either an auth route or protected.
  if (!user && !isDemo && !isAuthRoute) {
    return NextResponse.redirect(new URL('/login', req.url))
  }

  if ((user || isDemo) && isAuthRoute) {
    return NextResponse.redirect(new URL('/flow', req.url))
  }

  return res
}

// Listed explicitly rather than as a catch-all: every path this matches costs a
// `supabase.auth.getUser()` round-trip, so the landing page, static assets and
// the /api/* proxy must not be in here.
export const config = {
  matcher: [
    '/calculator/:path*',
    '/dark-pool/:path*',
    '/flow/:path*',
    '/gex/:path*',
    '/heat-map/:path*',
    '/macro/:path*',
    '/news/:path*',
    '/optimizer/:path*',
    '/power-alerts/:path*',
    '/settings/:path*',
    '/watchlist/:path*',
    '/login/:path*',
    '/register/:path*',
  ],
}