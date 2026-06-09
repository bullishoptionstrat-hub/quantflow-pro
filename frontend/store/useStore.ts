import { create } from 'zustand'
import type { FlowFilters, FlowEvent, PowerAlert } from '@/lib/types'

interface Store {
  // Filters
  filters: FlowFilters
  setFilters: (f: Partial<FlowFilters>) => void
  resetFilters: () => void
  // Voice
  voiceEnabled: boolean
  setVoiceEnabled: (v: boolean) => void
  // Watchlist
  watchlist: string[]
  addToWatchlist: (t: string) => void
  removeFromWatchlist: (t: string) => void
  // Flow
  flowEvents: FlowEvent[]
  addFlowEvent: (e: FlowEvent) => void
  addFlowBatch: (batch: FlowEvent[]) => void
  clearFlow: () => void
  // Alerts
  powerAlerts: PowerAlert[]
  addPowerAlert: (a: PowerAlert) => void
  // Connection
  connected: boolean
  setConnected: (v: boolean) => void
  // Ticker
  selectedTicker: string
  setSelectedTicker: (t: string) => void
}

const DEFAULT_FILTERS: FlowFilters = {
  ticker: '',
  minPremium: 25000,
  optionType: 'ALL',
  orderType: 'ALL',
  sentiment: 'ALL',
  minHeat: 0,
  unusualOnly: false,
}

export const useStore = create<Store>((set, get) => ({
  filters: { ...DEFAULT_FILTERS },
  setFilters: (f) => set(s => ({ filters: { ...s.filters, ...f } })),
  resetFilters: () => set({ filters: { ...DEFAULT_FILTERS } }),

  voiceEnabled: true,
  setVoiceEnabled: (v) => set({ voiceEnabled: v }),

  watchlist: ['NVDA', 'SPX', 'SPY', 'QQQ', 'MSTR'],
  addToWatchlist: (t) => set(s => {
    const upper = t.toUpperCase()
    if (s.watchlist.includes(upper)) return s
    return { watchlist: [...s.watchlist, upper] }
  }),
  removeFromWatchlist: (t) => set(s => ({ watchlist: s.watchlist.filter(x => x !== t) })),

  flowEvents: [],
  addFlowEvent: (e) => set(s => {
    const events = [e, ...s.flowEvents].slice(0, 500)
    return { flowEvents: events }
  }),
  addFlowBatch: (batch) => set(s => {
    const events = [...batch, ...s.flowEvents].slice(0, 500)
    return { flowEvents: events }
  }),
  clearFlow: () => set({ flowEvents: [] }),

  powerAlerts: [],
  addPowerAlert: (a) => set(s => ({ powerAlerts: [a, ...s.powerAlerts].slice(0, 100) })),

  connected: false,
  setConnected: (v) => set({ connected: v }),

  selectedTicker: 'SPY',
  setSelectedTicker: (t) => set({ selectedTicker: t }),
}))
