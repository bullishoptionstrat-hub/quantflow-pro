import { createServerClient } from '@supabase/ssr'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export async function middleware(req: NextRequest) {
  const res = NextResponse.next()
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

  const { data: { user } } = await supabase.auth.getUser()

  const isAuthRoute = req.nextUrl.pathname.startsWith('/login') || req.nextUrl.pathname.startsWith('/register')

  // Everything the matcher lets through is either an auth route or protected.
  if (!user && !isAuthRoute) {
    return NextResponse.redirect(new URL('/login', req.url))
  }

  if (user && isAuthRoute) {
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