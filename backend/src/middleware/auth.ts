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
    try {
      const { data, error } = await supabase.auth.getUser(token);
      if (!error && data?.user) {
        return {
          ok: true,
          identity: {
            user: { id: data.user.id, email: data.user.email, role: data.user.role },
            demo: false,
          },
        };
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
