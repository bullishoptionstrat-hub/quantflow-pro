'use client'
import { useEffect, useCallback } from 'react'
import { useStore } from '@/store/useStore'
import { isPowerAlert } from '@/lib/flowFilter'
import type { FlowEvent } from '@/lib/types'

/**
 * The live flow feed.
 *
 * This hook used to manufacture the tape. On mount it seeded the store with 50
 * events from `generateSeedFlow` — random tickers, random premiums up to $15M,
 * random heat scores, spot prices hardcoded at 2024 values — and then, while
 * the socket was not connected, invented one more every eight seconds.
 *
 * The seeded fifty went in through `addFlowBatch`, so they only misinformed
 * whoever was reading. The eight-second ones went through `handleEvent`, and
 * that path does more than store an event: at `heat_score >= 75` it raises a
 * power alert, above 80 it **speaks the trade aloud**, and above 85 it fires an
 * **OS push notification**. `generateSeedFlow` drew heat uniformly from 40 to
 * 100. So a terminal with no market data connection was announcing sweeps that
 * had not happened, out loud and onto the desktop.
 *
 * None of it carried `synthetic`, either, so the per-row marker in `FlowFeed`
 * did not cover it — flagging the generator would have left the speech and the
 * notifications firing on invented trades regardless, since neither
 * `speakAlert` nor `pushNotification` looks at that field.
 *
 * It is deleted rather than marked. The backend already simulates prints when
 * no vendor keys are configured, and flags them `synthetic` on the wire where
 * the UI can see it — so the client-side fabricator was redundant even in its
 * honest form. With nothing arriving, the feed is empty and says why.
 */

function speakAlert(event: FlowEvent) {
  if (typeof window === 'undefined' || !window.speechSynthesis) return
  const premium = event.total_premium >= 1_000_000
    ? `${(event.total_premium / 1_000_000).toFixed(1)} million`
    : `${Math.round(event.total_premium / 1000)}K`
  const utt = new SpeechSynthesisUtterance(
    `${event.underlying} ${event.option_type === 'C' ? 'call' : 'put'} sweep, ${premium} premium, ${event.sentiment.toLowerCase()}`
  )
  utt.rate = 1.1
  utt.pitch = 1
  window.speechSynthesis.speak(utt)
}

function pushNotification(event: FlowEvent) {
  // `typeof window === 'undefined' || Notification.permission !== 'granted'`
  // was the guard, and it throws a ReferenceError wherever the Notifications
  // API is absent but `window` is not — iOS Safari, any embedded webview, and
  // jsdom. The throw lands inside the socket's batch handler, so one heat-86
  // print took the whole feed down on those browsers.
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return
  if (Notification.permission !== 'granted') return
  new Notification(`⚡ ${event.underlying} ${event.option_type === 'C' ? 'CALL' : 'PUT'} SWEEP`, {
    body: `${event.total_premium >= 1_000_000 ? (event.total_premium / 1_000_000).toFixed(1) + 'M' : Math.round(event.total_premium / 1000) + 'K'} | Heat: ${event.heat_score} | ${event.sentiment}`,
    icon: '/favicon.ico',
    tag: event.id,
    silent: false,
  })
}

/** Spoken aloud above this heat, when voice is on. */
const SPEAK_ABOVE = 80
/** Pushed to the desktop above this heat. */
const PUSH_ABOVE = 85

export function useFlowFeed() {
  const { voiceEnabled, addFlowEvent, addPowerAlert, setConnected, flowEvents } = useStore()

  /**
   * Every signal that arrives is stored. Nothing here consults the filters.
   *
   * `handleEvent` used to begin `if (!passesFilters(event)) return`, so the
   * store held only what matched the filters *at the moment each signal
   * arrived* — and the filters are a view control the reader moves. Raising
   * `minPremium` to $1M for a minute and putting it back deleted every
   * sub-$1M print from that minute, permanently, while the control said they
   * were admitted again. Widening a filter cannot recover data that was never
   * kept. `FlowFeed` filters for display, which is where a view control
   * belongs.
   *
   * The alert path no longer runs behind that gate either — see
   * `isPowerAlert`. The speech and push thresholds are unchanged; what is gone
   * is a display filter deciding what the terminal says out loud.
   */
  const handleEvent = useCallback((event: FlowEvent) => {
    addFlowEvent(event)

    if (voiceEnabled && event.heat_score > SPEAK_ABOVE) speakAlert(event)
    if (event.heat_score > PUSH_ABOVE) pushNotification(event)

    if (isPowerAlert(event)) {
      addPowerAlert({
        id: `alert-${event.id}`,
        underlying: event.underlying,
        // Was `event.order_type as any`. `PowerAlert.alert_type` declared
        // SWEEP/BLOCK/DARK_POOL/GEX_FLIP/ML_SIGNAL while the values arriving
        // are `OrderType` — SPLIT, MULTI_LEG and LARGE were not in the union
        // and three of the union's members were produced by nothing. The cast
        // was what let the two disagree; the type now says what arrives.
        alert_type: event.order_type,
        message: `${event.underlying} ${event.option_type === 'C' ? 'CALL' : 'PUT'} ${event.order_type} — $${event.total_premium >= 1e6 ? (event.total_premium / 1e6).toFixed(1) + 'M' : Math.round(event.total_premium / 1000) + 'K'} premium`,
        heat_score: event.heat_score,
        created_at: event.created_at,
        flow_event_id: event.id,
      })
    }
  }, [voiceEnabled, addFlowEvent, addPowerAlert])

  useEffect(() => {
    let socket: any = null

    const trySocket = async () => {
      try {
        const { getSocket } = await import('@/lib/socket')
        socket = getSocket()
        socket.on('connect', () => setConnected(true))
        socket.on('disconnect', () => setConnected(false))
        // `flow_update` is not emitted by the backend — `emitSignals` sends a
        // single global `flow_batch`. Kept off deliberately rather than left as
        // a listener for an event that stopped existing before v3.
        socket.on('flow_batch', (batch: FlowEvent[]) => batch.forEach(handleEvent))
      } catch {
        // Loading the client failed outright. `connected` stays false and the
        // feed says so; there is nothing to substitute.
        setConnected(false)
      }
    }
    trySocket()

    // The eight-second fabricator lived here. It is gone rather than gated:
    // it fed `handleEvent`, which speaks a trade aloud above heat 80 and pushes
    // an OS notification above 85, on events it had just invented.

    return () => {
      if (socket) {
        socket.off('flow_batch')
      }
    }
  }, [handleEvent, setConnected])

  return { events: flowEvents }
}
