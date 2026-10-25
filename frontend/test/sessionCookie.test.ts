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

test('the middleware reads that cookie and lets a signed-in request through', async () => {
  // Built here in the format the browser client writes (the name carries the
  // project ref, the value is the URL-encoded session JSON) rather than by
  // signing in: @supabase/ssr caches one browser client per test run, so a
  // client another file built would name the cookie after a different project.
  const now = Math.floor(Date.now() / 1000)
  const session = {
    access_token: 'header.payload.signature', token_type: 'bearer', expires_in: 3600,
    expires_at: now + 3600, refresh_token: 'refresh-token',
    user: { id: '00000000-0000-0000-0000-000000000001', aud: 'authenticated', role: 'authenticated', email: 'a@b.co' },
  }
  const cookie = `sb-abcdefghijklmnopqrst-auth-token=${encodeURIComponent(JSON.stringify(session))}`

  const { NextRequest } = await import('next/server')
  const { middleware } = await import('../middleware')
  const userCalls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    userCalls.push(String(url))
    return new Response(JSON.stringify({
      id: '00000000-0000-0000-0000-000000000001', aud: 'authenticated', role: 'authenticated', email: 'a@b.co',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))

  const res = await middleware(new NextRequest('https://app.example/flow/', { headers: { cookie } }))
  // The middleware asked Supabase who the session belongs to, so it read the cookie.
  expect(userCalls.some((u) => u.includes('/auth/v1/user'))).toBe(true)
  // And it did not bounce the request to /login.
  expect(res.headers.get('location') ?? '').not.toContain('/login')
})

test('without a session cookie the middleware still sends a gated page to /login', async () => {
  const { NextRequest } = await import('next/server')
  const { middleware } = await import('../middleware')
  const res = await middleware(new NextRequest('https://app.example/flow/'))
  expect(res.status).toBe(307)
  expect(res.headers.get('location')).toBe('https://app.example/login')
})

test('a cookie Supabase does not accept is not a session', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ code: 401, msg: 'invalid JWT' }),
    { status: 401, headers: { 'Content-Type': 'application/json' } },
  )))
  const now = Math.floor(Date.now() / 1000)
  const forged = {
    access_token: 'forged.token.value', token_type: 'bearer', expires_in: 3600,
    expires_at: now + 3600, refresh_token: 'x',
    user: { id: '00000000-0000-0000-0000-000000000002', aud: 'authenticated', role: 'authenticated', email: 'x@y.z' },
  }
  const { NextRequest } = await import('next/server')
  const { middleware } = await import('../middleware')
  const res = await middleware(new NextRequest('https://app.example/flow/', {
    headers: { cookie: `sb-abcdefghijklmnopqrst-auth-token=${encodeURIComponent(JSON.stringify(forged))}` },
  }))
  // The middleware trusts Supabase's verdict, not the cookie's own claims.
  expect(res.headers.get('location')).toBe('https://app.example/login')
})
