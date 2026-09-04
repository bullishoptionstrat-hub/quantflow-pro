/**
 * Demo mode could not start on a deployment with no Supabase project — which
 * is the only kind of deployment it exists for.
 *
 * Two places built a Supabase client eagerly, and `createClient` /
 * `createServerClient` **throw** when either env var is missing:
 *
 *   - `middleware.ts` constructed one before it checked the demo cookie, so
 *     every gated route returned 500 rather than redirecting to `/login`.
 *   - `lib/supabase.ts` constructed one at module load with `!` assertions.
 *     Every page imports it — `apiFetch`, `socket`, `DemoBanner`, both auth
 *     pages — so the login page that *offers the demo button* threw before it
 *     could render.
 *
 * Measured, before the fix:
 *
 *     GET /flow/   → 500   Error: Your project's URL and Key are required
 *     GET /login/  → 500   Error: supabaseUrl is required.
 *
 * The escape hatch was behind the door it was meant to open. The stand-in does
 * not fake a session: it answers "there is no session" where that is the
 * truth, and returns a stated configuration error where a question cannot be
 * answered at all.
 */
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const URL_VAR = 'NEXT_PUBLIC_SUPABASE_URL'
const KEY_VAR = 'NEXT_PUBLIC_SUPABASE_ANON_KEY'

const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  vi.resetModules()
  for (const v of [URL_VAR, KEY_VAR, 'NEXT_PUBLIC_DEMO_MODE']) saved[v] = process.env[v]
})

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  vi.doUnmock('@/lib/apiFetch')
})

function unconfigure() {
  delete process.env[URL_VAR]
  delete process.env[KEY_VAR]
}

describe('with no Supabase project configured', () => {
  test('importing the client does not throw', async () => {
    // The whole failure. `createClient(undefined!, undefined!)` throws
    // "supabaseUrl is required" at module evaluation, so importing this file
    // from any page was enough to 500 it.
    unconfigure()
    const mod = await import('@/lib/supabase')
    expect(mod.isSupabaseConfigured).toBe(false)
    expect(mod.supabase).toBeDefined()
  })

  test('there is no session, reported as no session rather than an error', async () => {
    // `apiFetch` asks this on every request. It has to get a plain answer.
    unconfigure()
    const { supabase } = await import('@/lib/supabase')
    const { data, error } = await supabase.auth.getSession()
    expect(data.session).toBeNull()
    expect(error).toBeNull()
  })

  test('signing in returns a stated configuration error, not a network failure', async () => {
    // The one question that genuinely cannot be answered. A blank page or a
    // fetch error would send the reader after the wrong problem.
    unconfigure()
    const { supabase } = await import('@/lib/supabase')
    const { error } = await supabase.auth.signInWithPassword({
      email: 'a@b.c', password: 'x',
    } as never)
    expect(error?.message).toMatch(/no Supabase project configured/i)
    expect(error?.message).toMatch(new RegExp(URL_VAR))
    expect(error?.message).toMatch(/demo mode/i)
  })

  test('a subscriber still gets something to unsubscribe with', async () => {
    // `lib/socket.ts` keeps the returned subscription and calls
    // `.unsubscribe()` in `disconnectSocket`. Returning a bare object would
    // move the crash rather than remove it.
    unconfigure()
    const { supabase } = await import('@/lib/supabase')
    const { data } = supabase.auth.onAuthStateChange(() => {})
    expect(typeof data.subscription.unsubscribe).toBe('function')
    expect(() => data.subscription.unsubscribe()).not.toThrow()
  })

  test('apiFetch asks for the demo tier instead of sending a token', async () => {
    // The path that has to work. No session and demo mode on means the demo
    // header, which is what the backend admits — and only for routes that
    // cost nothing per call.
    unconfigure()
    process.env.NEXT_PUBLIC_DEMO_MODE = '1'

    const calls: Array<{ url: string; headers: Headers }> = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, headers: new Headers(init.headers) })
      return { ok: true, status: 200, json: async () => ({}) } as Response
    })

    const { apiFetch } = await import('@/lib/apiFetch')
    await apiFetch('/api/flow')

    expect(calls).toHaveLength(1)
    expect(calls[0].headers.get('x-quantflow-demo')).toBe('1')
    expect(calls[0].headers.get('authorization')).toBeNull()
    vi.unstubAllGlobals()
  })

  test('with demo mode off it asks for nothing, and the backend refuses', async () => {
    // Two independent conditions. Without the deployment opting in, no header
    // is sent and the request is simply unauthenticated.
    unconfigure()
    delete process.env.NEXT_PUBLIC_DEMO_MODE

    const calls: Array<Headers> = []
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      calls.push(new Headers(init.headers))
      return { ok: false, status: 401, json: async () => ({}) } as Response
    })

    const { apiFetch } = await import('@/lib/apiFetch')
    await apiFetch('/api/flow')

    expect(calls[0].get('x-quantflow-demo')).toBeNull()
    expect(calls[0].get('authorization')).toBeNull()
    vi.unstubAllGlobals()
  })
})

describe('with Supabase configured', () => {
  test('a real client is built', async () => {
    process.env[URL_VAR] = 'https://project.supabase.test'
    process.env[KEY_VAR] = 'anon-key'
    const mod = await import('@/lib/supabase')
    expect(mod.isSupabaseConfigured).toBe(true)
    // The stand-in implements `auth` and nothing else; a real client has more.
    expect(typeof (mod.supabase as unknown as { from?: unknown }).from).toBe('function')
  })
})

describe('the middleware does not build a client it cannot build', () => {
  const MIDDLEWARE = join(__dirname, '..', 'middleware.ts')
  const code = () =>
    readFileSync(MIDDLEWARE, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')

  test('the client is constructed only when both values exist', () => {
    const src = code()
    const guardAt = src.indexOf('if (supabaseConfigured())')
    const buildAt = src.indexOf('createServerClient(')

    expect(guardAt, 'the guard must exist').toBeGreaterThan(-1)
    expect(buildAt, 'the client must still be built when it can be').toBeGreaterThan(-1)
    // Ordering, not absence: the call is fine, calling it unconditionally is
    // not. It used to be the first statement in the handler.
    expect(buildAt).toBeGreaterThan(guardAt)
    expect(src).toMatch(/NEXT_PUBLIC_SUPABASE_URL && process\.env\.NEXT_PUBLIC_SUPABASE_ANON_KEY/)
  })

  test('the demo path is still two independent conditions', () => {
    // Skipping the client must not become skipping the gate. A demo session
    // needs the deployment to have opted in *and* the cookie to be present.
    expect(code()).toMatch(/isDemoModeEnabled\(\) && req\.cookies\.get\(DEMO_COOKIE\)\?\.value === '1'/)
    expect(code()).toMatch(/if \(!user && !isDemo && !isAuthRoute\)/)
  })
})
