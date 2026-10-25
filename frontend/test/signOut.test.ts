/**
 * Signing out must remove the session the middleware reads, and a failed
 * sign-out must say so rather than redirect.
 *
 * Runs the real browser client against a stubbed auth endpoint. supabase-js
 * keeps the session when the logout call fails, so redirecting regardless
 * would send the reader to /login, where the middleware finds the surviving
 * cookie and sends them straight back in, signed in, after "signing out".
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const SESSION_COOKIE = /(^|; )sb-[a-z0-9]+-auth-token(\.0)?=[^;]+/

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function tokenResponse() {
  const now = Math.floor(Date.now() / 1000)
  return json({
    access_token: 'header.payload.signature', token_type: 'bearer', expires_in: 3600,
    expires_at: now + 3600, refresh_token: 'refresh-token',
    user: { id: '00000000-0000-0000-0000-000000000001', aud: 'authenticated', role: 'authenticated', email: 'a@b.co' },
  })
}

let logoutStatus = 204
const assign = vi.fn()

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://abcdefghijklmnopqrst.supabase.co')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key')
  document.cookie.split(';').forEach((c) => {
    document.cookie = c.split('=')[0]!.trim() + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'
  })
  localStorage.clear()
  assign.mockReset()
  vi.stubGlobal('location', { ...window.location, assign })
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    const u = String(url)
    if (u.includes('/auth/v1/token')) return tokenResponse()
    if (u.includes('/auth/v1/logout')) {
      return logoutStatus === 204 ? new Response(null, { status: 204 }) : json({ msg: 'unavailable' }, logoutStatus)
    }
    return json({}, 404)
  }))
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

test('signing out clears the session cookie and leaves for /login', async () => {
  logoutStatus = 204
  const { supabase } = await import('@/lib/supabase')
  await supabase.auth.signInWithPassword({ email: 'a@b.co', password: 'x' })
  expect(document.cookie).toMatch(SESSION_COOKIE)

  const { signOut } = await import('@/lib/signOut')
  const result = await signOut()

  expect(result.error).toBeNull()
  expect(document.cookie).not.toMatch(SESSION_COOKIE)
  expect(assign).toHaveBeenCalledWith('/login/')
  const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]))
  // This browser only: the server is asked to revoke this session, not every device's.
  expect(calls.some((u) => u.includes('/auth/v1/logout') && u.includes('scope=local'))).toBe(true)
})

test('a sign-out the server did not complete is reported, not redirected', async () => {
  logoutStatus = 503
  const { supabase } = await import('@/lib/supabase')
  await supabase.auth.signInWithPassword({ email: 'a@b.co', password: 'x' })

  const { signOut, SIGN_OUT_FAILED } = await import('@/lib/signOut')
  const result = await signOut()

  expect(result.error).toBe(SIGN_OUT_FAILED)
  // The session survived, so claiming otherwise would be false.
  expect(document.cookie).toMatch(SESSION_COOKIE)
  expect(assign).not.toHaveBeenCalled()
})
