/**
 * The states that used to be unreachable.
 *
 * Until `generateSeedFlow` was deleted, `useFlowFeed` seeded the store with 50
 * invented events on mount, so no page built from the store could ever be
 * empty. That made every empty state dead code — and the heat map simply did
 * not have one, rendering a bare grid with no explanation the moment the
 * fabricator went away.
 *
 * Backend tests can assert that `heatData.length === 0` appears in the source.
 * They cannot assert that it renders anything a person can read. That is the
 * gap this file closes.
 */
import { describe, expect, test, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import HeatMapPage from '@/app/heat-map/page'
import PowerAlertsPage from '@/app/power-alerts/page'
import { useStore } from '@/store/useStore'

/** Reset the zustand store between renders — it is a module singleton. */
function setStore(patch: Record<string, unknown>) {
  useStore.setState(patch as never)
}

beforeEach(() => {
  setStore({ flowEvents: [], powerAlerts: [], connected: false, watchlist: [] })
})

describe('heat map', () => {
  test('an empty store explains itself instead of rendering a bare grid', () => {
    render(<HeatMapPage />)
    expect(screen.getByText(/Nothing to map yet/i)).toBeDefined()
  })

  test('it distinguishes a quiet feed from a disconnected one', () => {
    // Two different problems. Saying "no data" to both sends the reader after
    // the wrong one — the same failure as a connector reporting `connected`
    // while fetching nothing.
    render(<HeatMapPage />)
    expect(screen.getByText(/not connected/i)).toBeDefined()

    setStore({ connected: true })
    render(<HeatMapPage />)
    expect(screen.getAllByText(/no signals have arrived/i).length).toBeGreaterThan(0)
  })

  test('with flow it tiles by ticker and stops explaining', () => {
    setStore({ connected: true, flowEvents: [
      flowEvent({ underlying: 'NVDA', total_premium: 2_000_000, heat_score: 80 }),
      flowEvent({ underlying: 'SPY', total_premium: 500_000, heat_score: 40 }),
    ] })
    render(<HeatMapPage />)
    // Each ticker appears twice — once as a tile, once in the table beneath.
    expect(screen.getAllByText('NVDA').length).toBeGreaterThan(0)
    expect(screen.getAllByText('SPY').length).toBeGreaterThan(0)
    expect(screen.queryByText(/Nothing to map yet/i)).toBeNull()
  })
})

describe('power alerts', () => {
  test('an empty store says so', () => {
    render(<PowerAlertsPage />)
    expect(screen.getByText(/No power alerts yet/i)).toBeDefined()
  })

  test('no alert presents a model confidence', () => {
    // `ml_score` and its "ML CONFIDENCE: N%" renderer are gone. Nothing ever
    // populated the field, and the service that would have was trained on
    // np.random with a fixed seed.
    setStore({ powerAlerts: [{
      id: 'a1', underlying: 'NVDA', alert_type: 'SWEEP',
      message: 'NVDA CALL SWEEP — $2.0M premium',
      heat_score: 88, created_at: new Date().toISOString(),
    }] })
    render(<PowerAlertsPage />)
    expect(screen.getByText(/NVDA CALL SWEEP/)).toBeDefined()
    expect(screen.queryByText(/ML CONFIDENCE/i)).toBeNull()
  })
})

/** A wire-shaped FlowEvent. Only the fields these pages read need be real. */
function flowEvent(over: Record<string, unknown> = {}) {
  return {
    id: `e-${Math.random().toString(36).slice(2)}`,
    underlying: 'SPY', expiry: '2026-09-18', strike: 500, option_type: 'C',
    order_type: 'SWEEP', total_size: 100, total_premium: 1_000_000,
    heat_score: 70, sentiment: 'BULLISH', is_unusual: true, exchange_count: 2,
    avg_price: 1.5, iv: 0.3, delta: 0.4, open_interest: 1000, days_to_expiry: 16,
    moneyness: 'OTM', spot_price: 500, created_at: new Date().toISOString(),
    source: 'tradier', ...over,
  } as never
}
