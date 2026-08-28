import { supabase } from './supabase'

/**
 * Calls our own origin's `/api/*` proxy (see the rewrites in next.config.js)
 * with the current Supabase access token attached.
 *
 * The backend's `requireAuth` reads a Bearer token, not a cookie — the Supabase
 * session cookie is scoped to this origin and never reaches Render through the
 * rewrite, so the token has to be forwarded explicitly.
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { data: { session } } = await supabase.auth.getSession()

  const headers = new Headers(init.headers)
  if (session?.access_token) {
    headers.set('Authorization', `Bearer ${session.access_token}`)
  }

  return fetch(path, { ...init, headers })
}
