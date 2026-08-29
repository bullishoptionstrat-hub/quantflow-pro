import { io, Socket } from 'socket.io-client'
import { supabase } from './supabase'

let socket: Socket | null = null

/**
 * The backend now authenticates the Socket.IO handshake
 * (docs/FORENSIC_AUDIT.md #29 — the socket previously streamed the same data
 * the `/api/*` routes protect, with no auth and `origin: '*'`).
 *
 * The token is read fresh on every (re)connection attempt rather than captured
 * once, because Supabase access tokens expire and this client reconnects
 * indefinitely. Passing a stale token on reconnect would look to the user like
 * a random logout an hour into a session.
 */
async function currentAccessToken(): Promise<string | undefined> {
  try {
    const { data } = await supabase.auth.getSession()
    return data.session?.access_token
  } catch {
    return undefined
  }
}

/**
 * Demo mode has no Supabase session, so without this flag the handshake is
 * refused and a demo visitor sees pages that render once from REST and then
 * never update — the live feed is the product.
 *
 * This is only half of the gate. The backend independently requires
 * `DEMO_MODE=1`, so setting this on the client alone opens nothing.
 */
function demoRequested(): boolean {
  return process.env.NEXT_PUBLIC_DEMO_MODE === '1'
}

export function getSocket(): Socket {
  if (!socket) {
    const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:3001'
    socket = io(WS_URL, {
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      timeout: 20000,
      transports: ['websocket', 'polling'],
      // socket.io calls this before every connection AND every reconnection,
      // so the token is always current.
      auth: (cb) => {
        void currentAccessToken().then((token) => {
          // The demo flag is sent alongside rather than instead of the token.
          // A real session still authenticates normally — the server only
          // falls back to demo when there is no token at all, so a signed-in
          // user in a demo-enabled deployment is not downgraded.
          cb(demoRequested() ? { token, demo: '1' } : { token })
        })
      },
    })

    socket.on('connect_error', (err) => {
      // The server distinguishes "sign in again" from "we're degraded"; surface
      // that rather than flattening both into a generic connection warning.
      const refusal = (err as Error & { data?: { refusal?: string } }).data?.refusal
      if (refusal === 'verification_unavailable') {
        console.warn('[Socket] Auth service unavailable — this is not a credential problem.')
      } else if (refusal === 'no_token' || refusal === 'invalid_token') {
        console.warn('[Socket] Not authenticated for the live feed; sign in again.')
      } else {
        console.warn('[Socket] Connection error:', err.message)
      }
    })
  }
  return socket
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect()
    socket = null
  }
}
