'use client'
import { useEffect, useCallback } from 'react'
import { useStore } from '@/store/useStore'
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
  if (typeof window === 'undefined' || Notification.permission !== 'granted') return
  new Notification(`⚡ ${event.underlying} ${event.option_type === 'C' ? 'CALL' : 'PUT'} SWEEP`, {
    body: `${event.total_premium >= 1_000_000 ? (event.total_premium / 1_000_000).toFixed(1) + 'M' : Math.round(event.total_premium / 1000) + 'K'} | Heat: ${event.heat_score} | ${event.sentiment}`,
    icon: '/favicon.ico',
    tag: event.id,
    silent: false,
  })
}

export function useFlowFeed() {
  const { filters, voiceEnabled, addFlowEvent, addPowerAlert, setConnected, flowEvents } = useStore()

  const passesFilters = useCallback((e: FlowEvent) => {
    if (filters.ticker && !e.underlying.includes(filters.ticker.toUpperCase())) return false
    if (e.total_premium < filters.minPremium) return false
    if (filters.optionType !== 'ALL' && e.option_type !== filters.optionType) return false
    if (filters.orderType !== 'ALL' && e.order_type !== filters.orderType) return false
    if (filters.sentiment !== 'ALL' && e.sentiment !== filters.sentiment) return false
    if (e.heat_score < filters.minHeat) return false
    if (filters.unusualOnly && !e.is_unusual) return false
    return true
  }, [filters])

  const handleEvent = useCallback((event: FlowEvent) => {
    if (!passesFilters(event)) return
    addFlowEvent(event)
    if (event.heat_score >= 75 || event.order_type === 'SWEEP') {
      if (voiceEnabled && event.heat_score > 80) speakAlert(event)
      if (event.heat_score > 85) pushNotification(event)
      if (event.is_unusual && event.heat_score >= 75) {
        addPowerAlert({
          id: `alert-${event.id}`,
          underlying: event.underlying,
          alert_type: event.order_type as any,
          message: `${event.underlying} ${event.option_type === 'C' ? 'CALL' : 'PUT'} ${event.order_type} — $${event.total_premium >= 1e6 ? (event.total_premium / 1e6).toFixed(1) + 'M' : Math.round(event.total_premium / 1000) + 'K'} premium`,
          heat_score: event.heat_score,
          created_at: event.created_at,
          flow_event_id: event.id,
        })
      }
    }
  }, [passesFilters, voiceEnabled, addFlowEvent, addPowerAlert])

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
