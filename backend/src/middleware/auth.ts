import { Request, Response, NextFunction } from 'express';
import { bearerFrom, verifyToken, verifierConfigured } from './verifyToken';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email?: string;
    role?: string;
  };
  /** Set when verification could not reach a verdict — an outage, not a denial. */
  authUnavailable?: string;
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

/**
 * Optional auth — attaches `user` when a valid Bearer token is present.
 * Routes that don't require auth still work (user will be undefined).
 *
 * It no longer swallows failures. A verification outage is recorded on the
 * request as `authUnavailable` and logged, so `requireAuth` can tell an outage
 * apart from a bad credential and an operator can see the cause.
 */
export async function optionalAuth(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const result = await verifyToken(bearerFrom(req.headers.authorization));

  switch (result.status) {
    case 'authenticated':
      req.user = result.user;
      break;
    case 'unavailable':
      // Never silent: this is the case that used to look identical to a bad
      // token, both to the user and in the (absent) logs.
      req.authUnavailable = result.reason;
      console.error(`[auth] token verification unavailable: ${result.reason}`);
      break;
    case 'rejected':
      console.warn(`[auth] token rejected: ${result.reason}`);
      break;
    case 'no_token':
      break;
  }
  next();
}

/**
 * Strict auth. Distinguishes "we say no" (401) from "we cannot say" (503).
 *
 * This is the gate for anything that costs money per call or returns entitled
 * vendor data: `/api/chain`, and the Firecrawl-backed enrichment endpoints.
 * Demo traffic must never reach those, so they do not use `requireAuthOrDemo`.
 *
 * Returning 401 during an auth-provider outage is what made an incident
 * indistinguishable from mass credential failure — for the user reading the
 * message and for the operator reading the dashboard. Note the 503 path is
 * reached only when verification could not produce a verdict, so an outage
 * never *admits* a request; it only changes how the refusal is reported.
 */
export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  await optionalAuth(req, res, async () => {
    if (req.user) return next();

    if (req.authUnavailable) {
      res.status(503).json({
        error: 'Authentication temporarily unavailable',
        detail: 'The identity provider could not be reached. This is not a credential problem.',
      });
      return;
    }

    res.status(401).json({ error: 'Unauthorized' });
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
    // Checked before the outage branch on purpose: a demo session does not
    // depend on the identity provider, so an IdP outage must not take demo
    // mode down with it.
    if (isDemoModeEnabled() && req.headers[DEMO_HEADER] === '1') {
      req.demo = true;
      return next();
    }

    // Same distinction `requireAuth` makes, and for the same reason (finding
    // #28): a real session holder who arrives while the identity provider is
    // unreachable has not presented a bad credential, and telling them they
    // are "Unauthorized" sends them to reset a password that works. This
    // still refuses the request — it only reports the refusal truthfully.
    if (req.authUnavailable) {
      res.status(503).json({
        error: 'Authentication temporarily unavailable',
        detail: 'The identity provider could not be reached. This is not a credential problem.',
      });
      return;
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

  // Verified through the same `verifyToken` seam the HTTP tier uses, rather
  // than a second Supabase client of its own. That is this function's stated
  // reason for living beside `requireAuthOrDemo` — "so the two tiers cannot
  // drift" — and two independently-constructed clients is precisely how they
  // would. `verifyToken` never throws; a transport failure comes back as
  // `unavailable`.
  const result = await verifyToken(token || undefined);

  switch (result.status) {
    case 'authenticated':
      return { ok: true, identity: { user: result.user, demo: false } };
    case 'rejected':
      // Logged, never returned to the caller. The coarse "Unauthorized" below
      // is about what crosses to an unauthenticated client; it is not a reason
      // to hide the cause from the operator.
      console.warn(`[socket] token rejected: ${result.reason}`);
      break;
    case 'unavailable':
      // An outage is not an auth failure, but it is still a refusal here: a
      // socket has no useful degraded state, so an unverifiable connection
      // must not receive the stream. Logged distinctly so an incident does not
      // read as a wave of bad credentials — the same confusion the HTTP tier's
      // 503 exists to prevent.
      console.error(`[socket] token verification unavailable: ${result.reason}`);
      break;
    case 'no_token':
      break;
  }

  // `=== '1'`, `=== true` and `=== 1` only: a truthy value like the string
  // "false" must not read as consent.
  //
  // Reached only when no verified session was established. A token that failed
  // to verify therefore falls through to here — which grants nothing it could
  // not get by sending no token at all, since demo admission depends on
  // `DEMO_MODE` and the client asking, never on the token.
  const asksForDemo = auth.demo === true || auth.demo === '1' || auth.demo === 1;
  if (isDemoModeEnabled() && asksForDemo) {
    return { ok: true, identity: { demo: true } };
  }

  return { ok: false, reason: 'Unauthorized' };
}

/** Whether socket auth can succeed at all, for the boot-time warning. */
export function socketAuthConfigured(): boolean {
  return verifierConfigured() || isDemoModeEnabled();
}
