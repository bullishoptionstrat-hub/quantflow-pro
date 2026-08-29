import { Request, Response, NextFunction } from 'express';
import { bearerFrom, verifyToken } from './verifyToken';

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
