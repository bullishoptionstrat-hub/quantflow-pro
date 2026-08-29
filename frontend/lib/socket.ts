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
        void currentAccessToken().then((token) => cb({ token }))
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
