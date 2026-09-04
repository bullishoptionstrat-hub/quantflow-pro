import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * The browser Supabase client, or an honest stand-in when none is configured.
 *
 * This module built the client at import time with `!` assertions on both env
 * vars, so `createClient` threw "supabaseUrl is required" the moment any page
 * imported it. That is every page: `apiFetch`, `socket`, `DemoBanner` and both
 * auth pages all reach it.
 *
 * The consequence was that **demo mode could not start**. It exists precisely
 * so the terminal works without a Supabase project, and the login page — the
 * one that offers the demo button — 500'd before it could render. The escape
 * hatch was behind the door it was meant to open. `middleware.ts` had the same
 * shape and is fixed the same way.
 *
 * The stand-in below does not fake a session. It answers "there is no session"
 * to the questions with an honest negative answer, and returns a stated error
 * to the ones that cannot be answered at all — signing in against a project
 * that does not exist is a configuration failure, and saying so beats a
 * network error or a blank page.
 */
export const isSupabaseConfigured = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
)

const NOT_CONFIGURED =
  'This deployment has no Supabase project configured, so it cannot sign anyone in. ' +
  'Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY, or use demo mode.'

/**
 * Answers as a client with no session would, because that is the truth.
 *
 * Typed through `SupabaseClient` so call sites are unchanged; only `auth` is
 * implemented, because `auth` is all this app uses it for. Anything else
 * reaching for a table here should fail loudly rather than silently, and does.
 */
function unconfiguredClient(): SupabaseClient {
  const noSession = async () => ({ data: { session: null }, error: null })
  const noUser = async () => ({
    data: { user: null },
    error: { message: NOT_CONFIGURED, name: 'AuthRetryableFetchError', status: 500 },
  })
  const refuse = async () => ({
    data: { user: null, session: null },
    error: { message: NOT_CONFIGURED, name: 'AuthApiError', status: 500 },
  })

  return {
    auth: {
      getSession: noSession,
      getUser: noUser,
      signInWithPassword: refuse,
      signUp: refuse,
      signOut: async () => ({ error: null }),
      // A caller that subscribes must still get an unsubscribe to call.
      onAuthStateChange: () => ({
        data: { subscription: { id: 'unconfigured', callback: () => {}, unsubscribe: () => {} } },
      }),
    },
  } as unknown as SupabaseClient
}

export const supabase: SupabaseClient = isSupabaseConfigured
  ? createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        auth: {
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: true,
        },
      },
    )
  : unconfiguredClient()

export async function getCurrentUser() {
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error) return null
  return user
}
