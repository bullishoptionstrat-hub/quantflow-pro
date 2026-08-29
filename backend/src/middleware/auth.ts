import { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';

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
  if (!supabase) return next();

  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (!error && data?.user) {
      req.user = {
        id: data.user.id,
        email: data.user.email,
        role: data.user.role,
      };
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
