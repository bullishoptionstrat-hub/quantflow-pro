import { io, Socket } from 'socket.io-client'
import { supabase } from './supabase'
import { isDemoModeEnabled } from './demo'

let socket: Socket | null = null
let authSubscription: { unsubscribe: () => void } | null = null

/**
 * The live flow feed.
 *
 * The backend gates the handshake on the same terms as `/api/flow`: a Supabase
 * access token, or the demo tier when the deployment has set `DEMO_MODE=1` and
 * the client asks for it. Before that gate existed this connected with no
 * credentials at all, from any origin.
 *
 * `auth` is a **callback, not an object**, and that is the whole reason this
 * file is more than three lines. socket.io re-invokes it before every
 * connection attempt, so a reconnect picks up the current access token.
 * Passing a plain object would freeze whatever token existed when the singleton
 * was first built — and Supabase access tokens are short-lived, so the socket
 * would keep working until the first network blip and then start failing its
 * handshake with a token that expired an hour ago. A page reload always looks
 * fine, which is what makes that failure mode easy to ship.
 */
export function getSocket(): Socket {
  if (socket) return socket

  const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:3001'

  socket = io(WS_URL, {
    autoConnect: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    timeout: 20000,
    transports: ['websocket', 'polling'],
    auth: (cb) => {
      // Called before each attempt. Fetching the session here rather than
      // closing over it is what keeps a refreshed token from being ignored.
      supabase.auth.getSession()
        .then(({ data: { session } }) => {
          const token = session?.access_token
          if (token) return cb({ token })
          // No session: ask for the demo tier. The backend still refuses unless
          // it has DEMO_MODE=1 — two independent conditions, as with the REST
          // header — so this is a request, not a bypass.
          cb(isDemoModeEnabled() ? { demo: true } : {})
        })
        .catch(() => cb(isDemoModeEnabled() ? { demo: true } : {}))
    },
  })

  socket.on('connect_error', (err) => {
    // The backend's reason is deliberately coarse ("Unauthorized") because it
    // crosses to an unauthenticated caller. Say plainly what it means here,
    // where the reader is the developer: the feed being gated looks identical
    // to the backend being down, and `useFlowFeed` quietly substitutes
    // simulated prints for both.
    const unauthorized = /unauthorized/i.test(err.message)
    console.warn(
      unauthorized
        ? '[Socket] Refused: the live feed needs a signed-in session, or a backend ' +
          'with DEMO_MODE=1. Showing simulated prints instead of real flow.'
        : `[Socket] Connection error: ${err.message}`,
    )
  })

  // A sign-in or sign-out has to reach a socket that is already open: the
  // handshake happened under the old identity and the server will not
  // re-evaluate it on its own.
  if (!authSubscription) {
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'TOKEN_REFRESHED') {
        // Reconnect rather than rebuild: `auth` is re-read on the next attempt.
        socket?.disconnect().connect()
      }
    })
    authSubscription = data.subscription
  }

  return socket
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect()
    socket = null
  }
  if (authSubscription) {
    authSubscription.unsubscribe()
    authSubscription = null
  }
}
