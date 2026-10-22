'use client'
import { useEffect, useCallback } from 'react'
import { useStore } from '@/store/useStore'
import { isPowerAlert } from '@/lib/flowFilter'
import { alertFor, desktopRule, speechRule, triggerText } from '@/lib/alertRules'
import type { AlertChannelFiring, FlowEvent } from '@/lib/types'

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

/** Speaks the alert and reports what happened, for the row. */
function speakAlert(event: FlowEvent, rule: string): AlertChannelFiring {
  if (typeof window === 'undefined' || !window.speechSynthesis) {
    return { channel: 'SPEECH', rule, delivered: false, reason: 'speech synthesis is unavailable in this browser' }
  }
  const premium = event.total_premium >= 1_000_000
    ? `${(event.total_premium / 1_000_000).toFixed(1)} million`
    : `${Math.round(event.total_premium / 1000)}K`
  // A constructed print says so out loud. The repo's note on the deleted seed
  // generator is that neither this function nor `pushNotification` reads
  // `synthetic`, so a flag on the data could not qualify what they announce —
  // and those prints reach here. The word goes first, before the ticker,
  // because a listener who looks up mid-sentence has already missed it.
  //
  // "Constructed", not "Simulated": `synthetic` is also set on real Schwab,
  // Tastytrade, marketData and Yahoo chain rows, which are synthesized from a
  // day's aggregate volume rather than generated. Saying "simulated" aloud
  // about a paid feed is a false claim, and this is the surface with the least
  // room to qualify it afterwards.
  const utt = new SpeechSynthesisUtterance(
    `${event.synthetic ? 'Constructed. ' : ''}${event.underlying} ${event.option_type === 'C' ? 'call' : 'put'} ${event.order_type.replace('_', ' ').toLowerCase()}, ${premium} premium, ${event.sentiment.toLowerCase()}`
  )
  utt.rate = 1.1
  utt.pitch = 1
  window.speechSynthesis.speak(utt)
  return { channel: 'SPEECH', rule, delivered: true }
}

/** Pushes the alert to the desktop and reports what happened, for the row. */
function pushNotification(event: FlowEvent, rule: string): AlertChannelFiring {
  // `typeof window === 'undefined' || Notification.permission !== 'granted'`
  // was the guard, and it throws a ReferenceError wherever the Notifications
  // API is absent but `window` is not — iOS Safari, any embedded webview, and
  // jsdom. The throw lands inside the socket's batch handler, so one heat-86
  // print took the whole feed down on those browsers.
  if (typeof window === 'undefined' || typeof Notification === 'undefined') {
    return { channel: 'DESKTOP', rule, delivered: false, reason: 'this browser has no Notifications API' }
  }
  if (Notification.permission !== 'granted') {
    return { channel: 'DESKTOP', rule, delivered: false, reason: `notification permission is "${Notification.permission}"` }
  }
  // Same rule as the speech, and the same reason: the badge in the terminal
  // does not travel with an OS notification. `SWEEP` was hardcoded in the
  // title while the event carries its own `order_type`, so a BLOCK arrived on
  // the desktop announced as a sweep. `SYN`, matching every in-app surface,
  // rather than `🧪 SIMULATED` — this one leaves the application entirely, so
  // it is the worst place to tell an operator their real feed is fake.
  new Notification(`${event.synthetic ? 'SYN · ' : '⚡ '}${event.underlying} ${event.option_type === 'C' ? 'CALL' : 'PUT'} ${event.order_type}`, {
    // The notification leaves the application, so it carries its own rule:
    // the one that raised the alert, and the one that sent it here.
    body: `${event.total_premium >= 1_000_000 ? (event.total_premium / 1_000_000).toFixed(1) + 'M' : Math.round(event.total_premium / 1000) + 'K'} | Heat: ${event.heat_score} | ${event.sentiment}\nRule: ${triggerText({ trigger: event.alert_trigger ?? null })}\nSent: ${rule}`,
    icon: '/favicon.ico',
    tag: event.id,
    silent: false,
  })
  return { channel: 'DESKTOP', rule, delivered: true }
}

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

    // Nothing below runs for a signal that is not an alert. Speech and the
    // desktop notification used to be checked beside the alert rather than
    // inside it, which held only while their thresholds sat above the
    // backend's; every firing now has a row that names its rule (5.3).
    if (!isPowerAlert(event)) return

    // `alert_type` is the signal's own `order_type` (it was `as any` against a
    // union missing three real values); `synthetic` travels so the alert is
    // marked, spoken and pushed as what it is. See `alertFor`.
    const alert = alertFor(event)
    const channels: AlertChannelFiring[] = []

    const say = speechRule(event.heat_score)
    if (say) {
      channels.push(voiceEnabled
        ? speakAlert(event, say)
        : { channel: 'SPEECH', rule: say, delivered: false, reason: 'voice is off' })
    }
    const push = desktopRule(event.heat_score)
    if (push) channels.push(pushNotification(event, push))

    addPowerAlert({ ...alert, channels })
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
