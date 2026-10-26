import { supabase } from '@/lib/supabase'

/**
 * Signs this browser out and leaves the terminal.
 *
 * `scope: 'local'` revokes this session's refresh token at Supabase and clears
 * the session cookie here; other devices stay signed in.
 *
 * supabase-js keeps the session when the server call fails (a network error,
 * a 5xx), so a failure is reported, not followed by a redirect: the
 * middleware would see the surviving cookie and send the reader straight back
 * in, and they would believe they had signed out.
 *
 * The redirect is a full page load for the same reason the login page does
 * one: the client router caches prefetched routes, and those were fetched
 * while signed in.
 */
export const SIGN_OUT_FAILED =
  'Sign-out did not reach the server, so this browser is still signed in. Check your connection and try again.'

export async function signOut(): Promise<{ error: string | null }> {
  const { error } = await supabase.auth.signOut({ scope: 'local' })
  if (error) return { error: SIGN_OUT_FAILED }
  window.location.assign('/login/')
  return { error: null }
}
