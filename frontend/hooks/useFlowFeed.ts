'use client'
import { useEffect, useCallback, useRef } from 'react'
import { useStore } from '@/store/useStore'
import type { FlowEvent, PowerAlert } from '@/lib/types'
import { generateSeedFlow } from '@/lib/utils'

// Seed with demo data immediately
let seeded = false

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
  const { filters, voiceEnabled, addFlowEvent, addFlowBatch, addPowerAlert, setConnected, flowEvents } = useStore()
  const simulatorRef = useRef<NodeJS.Timeout | null>(null)

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
          ml_score: event.ml_score || 0,
          created_at: event.created_at,
          flow_event_id: event.id,
        })
      }
    }
  }, [passesFilters, voiceEnabled, addFlowEvent, addPowerAlert])

  useEffect(() => {
    // Seed demo data immediately
    if (!seeded) {
      seeded = true
      const seed = generateSeedFlow(50)
      addFlowBatch(seed)
    }

    // Try to connect to real backend
    let socket: any = null
    let socketLoaded = false

    const trySocket = async () => {
      try {
        const { getSocket } = await import('@/lib/socket')
        socket = getSocket()
        socket.on('connect', () => { setConnected(true); socketLoaded = true })
        socket.on('disconnect', () => setConnected(false))
        socket.on('flow_update', handleEvent)
        socket.on('flow_batch', (batch: FlowEvent[]) => batch.forEach(handleEvent))
      } catch (e) {
        console.warn('Socket unavailable, using simulation mode')
      }
    }
    trySocket()

    // Simulate new events every 15s when not connected to real backend
    const tickers = ['NVDA','SPX','SPY','QQQ','MSTR','MSFT','AAPL','META','TSLA','AMD']
    simulatorRef.current = setInterval(() => {
      if (socketLoaded) return
      const [event] = generateSeedFlow(1)
      const ticker = tickers[Math.floor(Math.random() * tickers.length)]
      handleEvent({ ...event, underlying: ticker, created_at: new Date().toISOString(), id: `sim-${Date.now()}` })
    }, 8000)

    return () => {
      if (simulatorRef.current) clearInterval(simulatorRef.current)
      if (socket) {
        socket.off('flow_update', handleEvent)
        socket.off('flow_batch')
      }
    }
  }, [handleEvent, addFlowBatch, setConnected])

  return { events: flowEvents }
}
