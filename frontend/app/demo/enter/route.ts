import { NextResponse } from 'next/server'
import { DEMO_COOKIE, isDemoModeEnabled } from '@/lib/demo'

/**
 * Enter demo mode.
 *
 * The cookie is set here rather than in the browser because `middleware.ts`
 * runs on the server and has to see it on the very next navigation — a
 * `document.cookie` write from the click handler races the redirect that
 * follows it, which is why the old "Continue as Guest" button (a bare
 * `router.push('/flow')`) bounced straight back to /login.
 *
 * Returns 404 when the deployment has not opted in, so the path does not exist
 * at all in a normal production build.
 */
export async function POST(request: Request) {
  if (!isDemoModeEnabled()) {
    return NextResponse.json({ error: 'Demo mode is not enabled' }, { status: 404 })
  }

  const res = NextResponse.redirect(new URL('/flow', request.url), { status: 303 })
  res.cookies.set(DEMO_COOKIE, '1', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    // Deliberately short. A demo session is for looking around, not a login.
    maxAge: 60 * 60 * 4,
  })
  return res
}
