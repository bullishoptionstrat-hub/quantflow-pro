/**
 * Socket.IO handshake authentication.
 *
 * ─── THE BYPASS THIS CLOSES (docs/FORENSIC_AUDIT.md #29) ────────────────────
 *
 * The six data routes sit behind `requireAuth`, on the stated grounds that they
 * "serve paid upstream data". The identical data was simultaneously broadcast
 * over Socket.IO with no authentication of any kind and `origin: '*'`:
 * `flow_batch` carries the same payload as `/api/flow`, and
 * `macro_update` / `sentiment_update` / `news_update` / `cboe_update` /
 * `spot_update` mirror `/api/macro` and `/api/sentiment`.
 *
 * Authenticating half the surface is worse than authenticating none of it,
 * because it produces the appearance of protection while leaving the cheapest
 * path to the data unguarded — and the guarded path is the one people test.
 *
 * FAIL CLOSED. A socket has no useful degraded state: it either streams the
 * data or it does not. So unlike the HTTP layer (which distinguishes 401 from
 * 503 so an operator can read an incident correctly), every non-authenticated
 * outcome here refuses the handshake. The REASON is still reported distinctly,
 * so a client can tell "log in again" from "the service is having a problem".
 */
import type { Server, Socket } from 'socket.io';
import { verifyToken } from './verifyToken';
import { isDemoModeEnabled } from './auth';

/** Why a handshake was refused. Closed union — no freeform strings. */
export type HandshakeRefusal =
  | 'no_token'
  | 'invalid_token'
  | 'verification_unavailable';

export interface SocketAuthResult {
  allowed: boolean;
  refusal?: HandshakeRefusal;
  reason?: string;
  user?: { id: string; email?: string; role?: string };
  /** True when admitted by demo mode rather than a verified session. */
  demo?: boolean;
}

/**
 * Whether this handshake is asking for a demo session, under the same two
 * independent conditions `requireAuthOrDemo` applies to HTTP: the deployment
 * must opt in via `DEMO_MODE=1` AND the client must ask. Neither a stray env
 * var nor a stray handshake field opens the stream alone.
 */
function wantsDemo(handshake: { auth?: Record<string, unknown> }): boolean {
  if (!isDemoModeEnabled()) return false;
  const flag = handshake.auth?.demo;
  return flag === '1' || flag === true;
}

/** Read the token a client supplies. Accepts the two idiomatic placements. */
export function handshakeToken(handshake: {
  auth?: Record<string, unknown>;
  headers?: Record<string, unknown>;
}): string | undefined {
  const fromAuth = handshake.auth?.token;
  if (typeof fromAuth === 'string' && fromAuth.trim().length > 0) return fromAuth.trim();

  // Browsers cannot set headers on a WebSocket upgrade, but non-browser
  // clients and the polling transport can, so accept it as a fallback.
  const header = handshake.headers?.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const t = header.slice('Bearer '.length).trim();
    if (t.length > 0) return t;
  }
  return undefined;
}

/**
 * Decide one handshake. Pure with respect to the socket — takes only the
 * handshake shape — so it is testable without standing up a server.
 */
export async function authenticateHandshake(handshake: {
  auth?: Record<string, unknown>;
  headers?: Record<string, unknown>;
}): Promise<SocketAuthResult> {
  const token = handshakeToken(handshake);
  const result = await verifyToken(token);

  switch (result.status) {
    case 'authenticated':
      return { allowed: true, user: result.user, demo: false };
    case 'no_token':
      // A demo session has no token by definition, so this is the only branch
      // it can be admitted from. Every socket event is one of the free or
      // simulated feeds `requireAuthOrDemo` already admits over HTTP
      // (flow/macro/sentiment/news/cboe/spot/crypto/stooq) — the chain and
      // enrichment endpoints are not broadcast, so this matches the HTTP
      // policy rather than widening it.
      if (wantsDemo(handshake)) return { allowed: true, demo: true };
      return { allowed: false, refusal: 'no_token', reason: 'no authentication token supplied' };
    case 'rejected':
      // NOT demo-admissible. A token that failed verification is a different
      // situation from having none: silently downgrading a rejected credential
      // to a demo session would hide an expired login behind working-looking
      // data, and would let the demo flag launder a bad token.
      return { allowed: false, refusal: 'invalid_token', reason: result.reason };
    case 'unavailable':
      // Deliberately still a refusal. An unverifiable connection must not
      // receive the stream just because the reason was infrastructural.
      return { allowed: false, refusal: 'verification_unavailable', reason: result.reason };
  }
}

/** Socket carrying the authenticated identity, once the guard has run. */
export interface AuthenticatedSocket extends Socket {
  user?: { id: string; email?: string; role?: string };
  /** True when this socket was admitted by demo mode; `user` is then absent. */
  demo?: boolean;
}

/**
 * Install the guard. Must be called BEFORE any `io.on('connection')` handler
 * that emits data, since `io.use` middleware runs at handshake time.
 */
export function installSocketAuth(io: Server): void {
  io.use(async (socket, next) => {
    const result = await authenticateHandshake(socket.handshake);

    if (result.allowed) {
      (socket as AuthenticatedSocket).user = result.user;
      (socket as AuthenticatedSocket).demo = result.demo === true;
      return next();
    }

    if (result.refusal === 'verification_unavailable') {
      console.error(`[socket] handshake refused — verification unavailable: ${result.reason}`);
    } else {
      console.warn(`[socket] handshake refused (${result.refusal}): ${result.reason}`);
    }

    const err = new Error(
      result.refusal === 'verification_unavailable'
        ? 'Authentication temporarily unavailable'
        : 'Unauthorized'
    );
    // socket.io surfaces `err.data` to the client's connect_error handler, so
    // the UI can tell "sign in again" from "the service is degraded".
    (err as Error & { data?: unknown }).data = { refusal: result.refusal };
    next(err);
  });
}
