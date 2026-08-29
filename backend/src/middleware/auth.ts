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
 * Returning 401 during an auth-provider outage is what made an incident
 * indistinguishable from mass credential failure — for the user reading the
 * message and for the operator reading the dashboard.
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
