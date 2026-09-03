/**
 * The page described a trigger the code does not implement, credited a model
 * that does not exist, and could not tell a simulated print from a real one.
 *
 * The subtitle read "AI-scored unusual activity · Heat ≥75 · SWEEP + Block
 * alerts". There is no model — `heat_score` is `flow-engine/score.ts`, and
 * `ml-service/` was deleted for putting a number with no provenance beside a
 * real signal, taking this page's `ML CONFIDENCE` line with it. BLOCK is not
 * special-cased anywhere, and a SWEEP raises nothing on its own. The empty
 * state was wrong a third way: "Heat ≥75 **or** unusual SWEEP" is a
 * disjunction, and the condition is `is_unusual && heat >= 75` on any order
 * type.
 *
 * And on every keyless deployment the backend simulates prints. A simulated
 * one clearing the threshold was rendered here, spoken aloud and pushed to the
 * desktop with nothing marking it.
 */
import { describe, expect, test, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import PowerAlertsPage from '@/app/power-alerts/page'
import { PowerAlertBanner } from '@/components/alerts/PowerAlertBanner'
import { useStore } from '@/store/useStore'
import type { PowerAlert } from '@/lib/types'

const alert = (o: Partial<PowerAlert> = {}): PowerAlert => ({
  id: `a${Math.random()}`,
  underlying: 'NVDA',
  alert_type: 'SWEEP',
  message: 'NVDA CALL SWEEP — $2.1M premium',
  heat_score: 88,
  created_at: new Date().toISOString(),
  flow_event_id: 'e1',
  ...o,
})

beforeEach(() => {
  useStore.setState({ powerAlerts: [], connected: false, voiceEnabled: false } as never)
})

describe('the page describes the trigger it has', () => {
  test('no AI is claimed, and the score names its source', () => {
    render(<PowerAlertsPage />)
    expect(screen.queryByText(/AI-scored/i)).toBeNull()
    expect(screen.getByText(/flow-engine\/score\.ts/)).toBeDefined()
    expect(screen.getByText(/deterministic score, not a model/i)).toBeDefined()
  })

  test('the stated condition is the conjunction the code applies', () => {
    const { container } = render(<PowerAlertsPage />)
    expect(container.textContent).toMatch(/unusual and scores it 75 or above/i)
    // The three claims that were not true: a SWEEP/BLOCK special case, and an
    // "or" where the code has an "and".
    expect(container.textContent).not.toMatch(/SWEEP \+ Block/i)
    expect(container.textContent).not.toMatch(/Heat ≥75 or/i)
  })
})

describe('an empty page says which kind of empty', () => {
  test('a disconnected feed is not a quiet one', () => {
    // Same distinction the heat map and the flow feed already make.
    const { container, rerender } = render(<PowerAlertsPage />)
    expect(container.textContent).toMatch(/Not connected to the flow feed/i)
    expect(container.textContent).toMatch(/See Settings/i)

    act(() => { useStore.setState({ connected: true } as never) })
    rerender(<PowerAlertsPage />)
    expect(container.textContent).toMatch(/No power alerts yet/i)
    expect(container.textContent).not.toMatch(/Not connected/i)
  })
})

describe('a simulated alert says so everywhere it appears', () => {
  test('on the row, and once at the top', () => {
    useStore.setState({ connected: true, powerAlerts: [alert({ synthetic: true }), alert()] } as never)
    const { container } = render(<PowerAlertsPage />)
    expect(screen.getByText(/SIMULATED/)).toBeDefined()
    expect(container.textContent).toMatch(/1 of these 2 alerts came from simulated prints/)
  })

  test('and in the banner across the top of the terminal', () => {
    // The least inspectable surface there is: a scrolling strip above every
    // page, with no room for provenance unless it is put there.
    useStore.setState({ powerAlerts: [alert({ synthetic: true })] } as never)
    const { container } = render(<PowerAlertBanner />)
    expect(container.textContent).toMatch(/🧪/)
  })

  test('a real alert carries no marker', () => {
    useStore.setState({ connected: true, powerAlerts: [alert()] } as never)
    const { container } = render(<PowerAlertsPage />)
    expect(container.textContent).not.toMatch(/SIMULATED|🧪/)
  })
})

describe('the heat score is not an opaque number', () => {
  test('its components are shown when the engine sent them', () => {
    // `ml_score`'s resolution: the opaque figure went and `score.ts` stayed,
    // because it publishes a per-component breakdown.
    useStore.setState({ connected: true, powerAlerts: [alert({
      score_breakdown: { premium: 30, sweep: 20, unusual_oi: 18, dte: -5 },
    })] } as never)
    const { container } = render(<PowerAlertsPage />)
    expect(container.textContent).toMatch(/premium \+30/)
    expect(container.textContent).toMatch(/dte -5/)
  })

  test('an alert without a breakdown renders without one', () => {
    useStore.setState({ connected: true, powerAlerts: [alert()] } as never)
    const { container } = render(<PowerAlertsPage />)
    expect(container.textContent).toMatch(/HEAT SCORE/)
    expect(container.textContent).not.toMatch(/undefined|NaN/)
  })
})

describe('alert types are the ones that exist', () => {
  test('every order type renders with its own colour', () => {
    useStore.setState({ connected: true, powerAlerts: [
      alert({ alert_type: 'MULTI_LEG' }), alert({ alert_type: 'LARGE' }), alert({ alert_type: 'SPLIT' }),
    ] } as never)
    const { container } = render(<PowerAlertsPage />)
    for (const t of ['MULTI_LEG', 'LARGE', 'SPLIT']) {
      expect(container.textContent).toMatch(new RegExp(t))
    }
    // `DARK_POOL`, `GEX_FLIP` and `ML_SIGNAL` were in the colour map and are
    // produced by nothing; `ML_SIGNAL` was the deleted service's slot.
    expect(container.innerHTML).not.toMatch(/ML_SIGNAL|GEX_FLIP|DARK_POOL/)
  })
})
