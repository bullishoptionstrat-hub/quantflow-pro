/**
 * Signing in must leave the session where middleware.ts can read it.
 *
 * middleware.ts gates every page with @supabase/ssr, which reads the session
 * from cookies. The browser client was supabase-js's createClient, which keeps
 * the session in localStorage, so a successful sign-in redirected to /flow and
 * was bounced straight back to /login: the login page looked dead. This signs
 * in against a stubbed auth endpoint and asserts the session is in a cookie,
 * and not only in localStorage.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const URL_ = 'https://abcdefghijklmnopqrst.supabase.co'

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', URL_)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key')
  document.cookie.split(';').forEach((c) => {
    document.cookie = c.split('=')[0]!.trim() + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'
  })
  localStorage.clear()
  const now = Math.floor(Date.now() / 1000)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    access_token: 'header.payload.signature',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: now + 3600,
    refresh_token: 'refresh-token',
    user: { id: '00000000-0000-0000-0000-000000000001', aud: 'authenticated', role: 'authenticated', email: 'a@b.co' },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

test('a successful sign-in writes the session to a cookie the middleware reads', async () => {
  const { supabase } = await import('@/lib/supabase')
  const { error } = await supabase.auth.signInWithPassword({ email: 'a@b.co', password: 'x' })
  expect(error).toBeNull()
  // The project ref in the name can come from a client another test file
  // already built (@supabase/ssr caches one per page); the name pattern is
  // what middleware.ts reads, whatever the ref.
  expect(document.cookie).toMatch(/(^|; )sb-[a-z0-9]+-auth-token(\.0)?=/)
})
