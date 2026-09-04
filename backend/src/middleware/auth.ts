import { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || '';

const supabase = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email?: string;
    role?: string;
  };
  /** True when this request was admitted by demo mode rather than a real session. */
  demo?: boolean;
}

/** Header the frontend sends when it is running without a Supabase session. */
export const DEMO_HEADER = 'x-quantflow-demo';

/**
 * Demo mode is opt-in per deployment and off unless `DEMO_MODE=1`.
 *
 * Read on each call rather than captured at import: `dotenv.config()` runs in
 * `server.ts` *after* its imports are evaluated, so a module-level read would
 * see the value from a `.env` file as undefined.
 */
export function isDemoModeEnabled(): boolean {
  return process.env.DEMO_MODE === '1';
}

// ─── Verified-token cache ───────────────────────────────────────────────────

/**
 * A short-lived cache of *successful* token verifications.
 *
 * Every authenticated request used to cost a `supabase.auth.getUser()` round
 * trip. The terminal polls: the ticker tape every 30s, the flow page, the
 * macro page, the news page. A signed-in reader with a few tabs open generates
 * a steady stream of calls to Supabase's `/auth/v1/user`, and that endpoint is
 * rate limited. When it limits, `getUser` errors, the catch in `optionalAuth`
 * swallows it, `req.user` stays undefined, and the request 401s — so a working
 * session is silently signed out by its own polling, and the terminal shows
 * "REFUSED — the backend did not accept this session" with nothing to act on.
 *
 * Three properties make this safe to cache:
 *
 *   - **Only successes are cached.** A failure may be transient — Supabase
 *     unreachable, a network blip — and caching it would keep a valid session
 *     locked out for the TTL. It also keeps a token-guessing flood from
 *     populating the map; that traffic is the rate limiter's problem, not this
 *     one's.
 *   - **An entry never outlives the token.** Supabase access tokens are JWTs
 *     carrying an `exp`, and an entry expires at `min(now + TTL, exp)`. The
 *     claim is read, never trusted: it can only *shorten* the entry, so a
 *     forged `exp` buys nothing — Supabase verified the signature before the
 *     entry existed at all.
 *   - **The key is a hash, not the token.** The token is already in memory
 *     because it arrived in a header, but a map keyed by raw credentials is
 *     one heap dump or one careless log away from leaking every live session.
 *
 * The cost is a revocation window: a token revoked in Supabase stays accepted
 * here for up to the TTL. That is the trade, it is bounded, and
 * `AUTH_CACHE_TTL_SECONDS` is the dial — set it to `0` to disable the cache and
 * verify every request, which is what happened before this existed.
 */
const AUTH_CACHE_TTL_MS = Math.max(
  0,
  (parseInt(process.env.AUTH_CACHE_TTL_SECONDS || '30', 10) || 0) * 1000,
);

/** Bounded so a flood of distinct tokens cannot grow it without limit. */
const AUTH_CACHE_MAX_ENTRIES = 1_000;

interface CachedIdentity {
  user: { id: string; email?: string; role?: string };
  expiresAt: number;
}

const verifiedTokens = new Map<string, CachedIdentity>();

function tokenKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * The `exp` claim, in ms, or null.
 *
 * Decoded, not verified — Supabase already verified the signature to produce
 * the success being cached. The value is used only to shorten the entry, so a
 * malformed or absent claim falls back to the TTL rather than extending it.
 */
function tokenExpiryMs(token: string): number | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const exp = typeof json?.exp === 'number' ? json.exp * 1000 : null;
    return exp !== null && Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}

function cachedUser(token: string): CachedIdentity['user'] | null {
  if (AUTH_CACHE_TTL_MS === 0) return null;
  const key = tokenKey(token);
  const hit = verifiedTokens.get(key);
  if (!hit) return null;
  if (Date.now() >= hit.expiresAt) {
    verifiedTokens.delete(key);
    return null;
  }
  return hit.user;
}

function cacheUser(token: string, user: CachedIdentity['user']): void {
  if (AUTH_CACHE_TTL_MS === 0) return;

  const exp = tokenExpiryMs(token);
  const expiresAt = exp === null
    ? Date.now() + AUTH_CACHE_TTL_MS
    : Math.min(Date.now() + AUTH_CACHE_TTL_MS, exp);
  // Already expired, or expiring within a millisecond: nothing worth keeping.
  if (expiresAt <= Date.now()) return;

  verifiedTokens.set(tokenKey(token), { user, expiresAt });

  if (verifiedTokens.size <= AUTH_CACHE_MAX_ENTRIES) return;
  const now = Date.now();
  for (const [k, v] of verifiedTokens) {
    if (verifiedTokens.size <= AUTH_CACHE_MAX_ENTRIES) break;
    if (now >= v.expiresAt) verifiedTokens.delete(k);
  }
  while (verifiedTokens.size > AUTH_CACHE_MAX_ENTRIES) {
    const oldest = verifiedTokens.keys().next();
    if (oldest.done) break;
    verifiedTokens.delete(oldest.value);
  }
}

/** Drop a token's cached verification. Exposed for tests and for a sign-out path. */
export function forgetVerifiedToken(token: string): void {
  verifiedTokens.delete(tokenKey(token));
}

/** Entry count, for tests and for anyone wondering what this is holding. */
export function verifiedTokenCacheSize(): number {
  return verifiedTokens.size;
}

/**
 * Optional auth middleware — attaches user to req if valid Bearer token present.
 * Routes that don't require auth still work (user will be undefined).
 */
export async function optionalAuth(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }

  const token = authHeader.split(' ')[1];
  // `Bearer ` with nothing after it passes `startsWith`. There is no token to
  // verify, so do not spend a round trip finding that out.
  if (!token) return next();
  if (!supabase) return next();

  const cached = cachedUser(token);
  if (cached) {
    req.user = cached;
    return next();
  }

  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (!error && data?.user) {
      req.user = {
        id: data.user.id,
        email: data.user.email,
        role: data.user.role,
      };
      // Successes only. A failure here may be Supabase being unreachable
      // rather than the token being bad, and caching that would lock a valid
      // session out for the whole TTL.
      cacheUser(token, req.user);
    }
  } catch {
    // swallow – auth is optional
  }
  next();
}

/**
 * Strict auth middleware — rejects unauthenticated requests with 401.
 *
 * This is the gate for anything that costs money per call or returns entitled
 * vendor data: `/api/chain`, and the Firecrawl-backed enrichment endpoints.
 * Demo traffic must never reach those, so they do not use `requireAuthOrDemo`.
 */
export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  await optionalAuth(req, res, async () => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  });
}

/**
 * Auth, or an explicitly-enabled demo session.
 *
 * A real Supabase session behaves exactly as before. Without one, a request is
 * admitted only when the deployment has opted in via `DEMO_MODE=1` *and* the
 * client asks for demo mode by header — two independent conditions, so neither
 * a stray header nor a misread env var opens the route on its own. When neither
 * holds, the response is the same 401 as `requireAuth`.
 *
 * `req.demo` is set so a handler can tell the two apart. Demo requests are
 * unauthenticated by definition: never widen this to routes that spend metered
 * credits or return data a vendor charges for.
 */
export async function requireAuthOrDemo(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  await optionalAuth(req, res, async () => {
    if (req.user) {
      req.demo = false;
      return next();
    }
    if (isDemoModeEnabled() && req.headers[DEMO_HEADER] === '1') {
      req.demo = true;
      return next();
    }
    res.status(401).json({ error: 'Unauthorized' });
  });
}

// ─── Socket.IO ──────────────────────────────────────────────────────────────

/**
 * The same decision as `requireAuthOrDemo`, for a websocket handshake.
 *
 * The live feed was the one door with no lock on it. Every REST route sits
 * behind `requireAuth` or `requireAuthOrDemo`, and `/api/flow` — which serves
 * exactly the signals the socket broadcasts — is on the demo-capable tier. But
 * `io.on('connection')` admitted anyone who connected, with `cors.origin: '*'`,
 * so any page on any origin could open a socket and receive `flow_batch`: the
 * classified signal feed, in real time, ungated. The careful two-tier split on
 * the HTTP side was being routed around by the transport that carries the same
 * data.
 *
 * It is written here rather than in `server.ts` so it cannot drift from the
 * middleware it mirrors. Same two independent conditions as the HTTP tier: a
 * demo socket needs the deployment to have opted in via `DEMO_MODE=1` *and*
 * the client to ask for it. Neither a stray flag nor a misread env var opens
 * the feed on its own.
 *
 * The failure reason is deliberately coarse — "Unauthorized" — for the same
 * purpose as the 401: a handshake error message crosses to an unauthenticated
 * caller and must not describe which of the two conditions failed.
 */
export interface SocketIdentity {
  user?: { id: string; email?: string; role?: string };
  demo: boolean;
}

export type SocketAuthResult =
  | { ok: true; identity: SocketIdentity }
  | { ok: false; reason: string };

/** What a client may put in `io(url, { auth })`. */
export interface SocketHandshakeAuth {
  /** Supabase access token, the same one the REST client sends as a Bearer. */
  token?: unknown;
  /** Asks for the demo tier. Honoured only when `DEMO_MODE=1`. */
  demo?: unknown;
}

export async function authenticateSocket(
  auth: SocketHandshakeAuth = {},
): Promise<SocketAuthResult> {
  const token = typeof auth.token === 'string' ? auth.token.trim() : '';

  if (token && supabase) {
    // Same cache as the HTTP tier, for the same reason: `socket.ts` passes
    // `auth` as a callback so every reconnect re-verifies, and a flapping
    // connection would otherwise hammer Supabase's auth endpoint until it
    // rate limits — at which point the socket is refused and the terminal
    // reports it as a configuration problem.
    const cached = cachedUser(token);
    if (cached) return { ok: true, identity: { user: cached, demo: false } };

    try {
      const { data, error } = await supabase.auth.getUser(token);
      if (!error && data?.user) {
        const user = { id: data.user.id, email: data.user.email, role: data.user.role };
        cacheUser(token, user);
        return { ok: true, identity: { user, demo: false } };
      }
    } catch {
      // Fall through to the demo check, then to refusal. A token that cannot be
      // verified is not a token — including when Supabase itself is unreachable.
    }
  }

  // `=== '1'` and `=== true` only: a truthy value like the string "false" must
  // not read as consent.
  const asksForDemo = auth.demo === true || auth.demo === '1' || auth.demo === 1;
  if (isDemoModeEnabled() && asksForDemo) {
    return { ok: true, identity: { demo: true } };
  }

  return { ok: false, reason: 'Unauthorized' };
}

/** Whether socket auth can succeed at all, for the boot-time warning. */
export function socketAuthConfigured(): boolean {
  return Boolean(supabase) || isDemoModeEnabled();
}
