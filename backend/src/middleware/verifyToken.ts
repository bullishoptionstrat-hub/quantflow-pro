/**
 * Bearer-token verification — the shared seam behind HTTP auth AND socket auth.
 *
 * ─── THE DISTINCTION THIS EXISTS TO MAKE ────────────────────────────────────
 *
 * The previous implementation swallowed its catch (`// swallow - auth is
 * optional`) and `requireAuth` delegated to it, so three very different
 * situations all produced an identical `401 Unauthorized`:
 *
 *   1. the caller sent no token at all,
 *   2. the caller sent a token and Supabase rejected it,
 *   3. Supabase was unreachable, or is not configured at all.
 *
 * (3) is not an authorization failure — it is an outage. Reporting it as 401
 * tells every user their credentials are bad during an incident, and tells the
 * operator nothing, because the cause was discarded. A closed result union
 * makes the three cases distinguishable at the type level, so a caller has to
 * decide what each one means rather than defaulting them all to "denied".
 *
 * Callers map these to transport-appropriate outcomes:
 *   HTTP   — authenticated → next(); no_token/rejected → 401; unavailable → 503.
 *   Socket — authenticated → allow; everything else → refuse the handshake,
 *            because a socket has no useful "degraded" state.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type TokenVerification =
  | { status: 'authenticated'; user: { id: string; email?: string; role?: string } }
  /** No Authorization header / no handshake token. Not an error, just absent. */
  | { status: 'no_token' }
  /** A token was supplied and the provider said no. This IS an auth failure. */
  | { status: 'rejected'; reason: string }
  /** We could not reach a verdict. NOT an auth failure — an outage or misconfig. */
  | { status: 'unavailable'; reason: string };

let client: SupabaseClient | null = null;
let clientResolved = false;

/**
 * Lazily built so tests can set env vars before first use, and so a missing
 * config is reported per-request as `unavailable` rather than throwing at
 * import time.
 */
function getClient(): SupabaseClient | null {
  if (!clientResolved) {
    const url = process.env.SUPABASE_URL || '';
    const key = process.env.SUPABASE_SERVICE_KEY || '';
    client = url && key ? createClient(url, key) : null;
    clientResolved = true;
  }
  return client;
}

/**
 * Whether verification can succeed at all — i.e. a Supabase client exists.
 * Used by `socketAuthConfigured()` for the boot-time warning; without it that
 * check would need its own copy of the client-construction rule.
 */
export function verifierConfigured(): boolean {
  return getClient() !== null;
}

/** Testing seam — forces the next getClient() to re-read the environment. */
export function resetTokenVerifierForTests(): void {
  client = null;
  clientResolved = false;
}

/** Extract a bearer token from an Authorization header value. */
export function bearerFrom(headerValue: string | undefined): string | undefined {
  if (!headerValue || !headerValue.startsWith('Bearer ')) return undefined;
  const token = headerValue.slice('Bearer '.length).trim();
  return token.length > 0 ? token : undefined;
}

/**
 * Verify a token. Never throws — every failure mode is a returned status, so a
 * caller cannot accidentally treat an outage as a rejection by forgetting a
 * try/catch.
 */
export async function verifyToken(token: string | undefined): Promise<TokenVerification> {
  if (!token) return { status: 'no_token' };

  const supabase = getClient();
  if (!supabase) {
    return {
      status: 'unavailable',
      reason: 'SUPABASE_URL / SUPABASE_SERVICE_KEY are unset — tokens cannot be verified',
    };
  }

  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error) {
      // The provider reached a verdict and it was "no". A genuine auth failure.
      return { status: 'rejected', reason: error.message };
    }
    if (!data?.user) {
      return { status: 'rejected', reason: 'token carried no user' };
    }
    return {
      status: 'authenticated',
      user: { id: data.user.id, email: data.user.email, role: data.user.role },
    };
  } catch (err: unknown) {
    // A thrown error is a transport/infrastructure failure, NOT a credential
    // failure. Never collapse it into 401 — and never swallow it.
    const reason = err instanceof Error ? err.message : String(err);
    return { status: 'unavailable', reason };
  }
}
