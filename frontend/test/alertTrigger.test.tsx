/**
 * ROADMAP 5.3 — whatever fires, the rule that fired it goes on the row.
 *
 * Three things fire on a signal: the alert row, speech and the desktop
 * notification. Before this, only the row had a rule anyone could read, and
 * only as a sentence on the page. These drive the real hook and the real page.
 */
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import type { AlertTrigger, FlowEvent, PowerAlert } from '@/lib/types'

const TRIGGER: AlertTrigger = {
  rule: 'UNUSUAL_SCORE', field: 'heat_score', op: '>=', threshold: 75, value: 88,
  text: 'heat_score 88 >= 75 (UNUSUAL_SCORE)',
}

const flow = (o: Partial<FlowEvent> = {}): FlowEvent => ({
  id: `e${Math.random()}`, underlying: 'NVDA', option_type: 'C', order_type: 'SWEEP',
  strike: 140, expiry: '2026-10-16', total_premium: 2_100_000, total_size: 100,
  heat_score: 88, sentiment: 'BULLISH', side: 'BUY',
  is_unusual: true, alert_trigger: TRIGGER, synthetic: false,
  created_at: new Date().toISOString(), ...o,
} as FlowEvent)

async function store() {
  return (await import('@/store/useStore')).useStore
}

let emit: ((batch: FlowEvent[]) => void) | null = null
async function mountFeed() {
  vi.doMock('@/lib/socket', () => ({
    getSocket: () => ({
      on: (event: string, cb: (b: FlowEvent[]) => void) => { if (event === 'flow_batch') emit = cb },
      off: () => {},
    }),
  }))
  const { useFlowFeed } = await import('@/hooks/useFlowFeed')
  function Probe() { useFlowFeed(); return null }
  render(<Probe />)
  await act(async () => {})
  expect(emit).not.toBeNull()
}
const send = async (events: FlowEvent[]) => { await act(async () => { emit!(events) }) }

beforeEach(async () => {
  vi.resetModules()
  emit = null
  ;(await store()).setState({ flowEvents: [], powerAlerts: [], connected: true, voiceEnabled: false } as never)
})
afterEach(() => vi.doUnmock('@/lib/socket'))

describe('the alert carries its rule and its channels', () => {
  test('the backend\'s rule is copied onto the alert verbatim', async () => {
    await mountFeed()
    await send([flow({ id: 'x' })])
    const a = (await store()).getState().powerAlerts[0]!
    expect(a.trigger).toEqual(TRIGGER)
  })

  test('a channel whose rule matched but did not deliver says so, and why', async () => {
    // Voice is off, and jsdom has no Notifications API: both rules match at
    // heat 88, and neither channel went out. "Matched and did not deliver" is
    // a different fact from "did not match", so both are recorded.
    await mountFeed()
    await send([flow({ id: 'y', heat_score: 88 })])
    const ch = (await store()).getState().powerAlerts[0]!.channels!
    const speech = ch.find((c) => c.channel === 'SPEECH')!
    const desktop = ch.find((c) => c.channel === 'DESKTOP')!
    expect(speech).toMatchObject({ delivered: false, reason: 'voice is off' })
    expect(speech.rule).toBe('heat_score 88 > 80 (SPEAK_ABOVE)')
    expect(desktop.delivered).toBe(false)
    expect(desktop.reason).toMatch(/Notifications API/)
    expect(desktop.rule).toBe('heat_score 88 > 85 (PUSH_ABOVE)')
  })

  test('a channel whose rule did not match is not listed', async () => {
    await mountFeed()
    await send([flow({ id: 'z', heat_score: 78 })])
    expect((await store()).getState().powerAlerts[0]!.channels).toEqual([])
  })

  test('nothing is spoken or pushed for a signal that raised no alert', async () => {
    // The channels used to be checked beside the alert. They held only while
    // their thresholds sat above the backend's; a heat-99 signal the backend
    // did NOT flag would have been spoken with no row recording it.
    const speak = vi.fn()
    ;(window as unknown as { speechSynthesis: unknown }).speechSynthesis = { speak }
    ;(await store()).setState({ voiceEnabled: true } as never)
    try {
      await mountFeed()
      await send([flow({ id: 'q', heat_score: 99, is_unusual: false, alert_trigger: null })])
      expect(speak).not.toHaveBeenCalled()
      expect((await store()).getState().powerAlerts).toEqual([])
    } finally {
      delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis
    }
  })

  test('a delivered spoken alert is recorded as delivered', async () => {
    const speak = vi.fn()
    ;(window as unknown as { speechSynthesis: unknown }).speechSynthesis = { speak }
    const Utt = vi.fn(function (this: { text: string }, t: string) { this.text = t })
    ;(globalThis as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = Utt
    ;(await store()).setState({ voiceEnabled: true } as never)
    try {
      await mountFeed()
      await send([flow({ id: 's', heat_score: 82 })])
      expect(speak).toHaveBeenCalledTimes(1)
      const ch = (await store()).getState().powerAlerts[0]!.channels!
      expect(ch).toEqual([{ channel: 'SPEECH', rule: 'heat_score 82 > 80 (SPEAK_ABOVE)', delivered: true }])
    } finally {
      delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis
      delete (globalThis as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance
    }
  })
})

describe('the row names its own trigger', () => {
  const alert = (o: Partial<PowerAlert> = {}): PowerAlert => ({
    id: `a${Math.random()}`, underlying: 'NVDA', alert_type: 'SWEEP',
    message: 'NVDA CALL SWEEP — $2.1M premium', heat_score: 88,
    created_at: new Date().toISOString(), flow_event_id: 'e1', ...o,
  })

  test('the backend\'s rule text and each channel appear on the row', async () => {
    const { default: PowerAlertsPage } = await import('@/app/power-alerts/page')
    ;(await store()).setState({ powerAlerts: [alert({
      trigger: TRIGGER,
      channels: [
        { channel: 'SPEECH', rule: 'heat_score 88 > 80 (SPEAK_ABOVE)', delivered: true },
        { channel: 'DESKTOP', rule: 'heat_score 88 > 85 (PUSH_ABOVE)', delivered: false, reason: 'notification permission is "default"' },
      ],
    })] } as never)
    render(<PowerAlertsPage />)
    const row = screen.getByTestId('alert-rule').textContent ?? ''
    expect(row).toContain('RULE heat_score 88 >= 75 (UNUSUAL_SCORE)')
    expect(row).toContain('SPOKEN: heat_score 88 > 80 (SPEAK_ABOVE)')
    expect(row).toContain('NOT DESKTOP: heat_score 88 > 85 (PUSH_ABOVE), but notification permission is "default"')
  })

  test('an older backend\'s alert says the rule was not published, and invents none', async () => {
    const { default: PowerAlertsPage } = await import('@/app/power-alerts/page')
    ;(await store()).setState({ powerAlerts: [alert()] } as never)
    render(<PowerAlertsPage />)
    const row = screen.getByTestId('alert-rule').textContent ?? ''
    expect(row).toMatch(/did not publish the rule/)
    expect(row).not.toMatch(/75/)
  })

  test('the page states the channel thresholds it runs', async () => {
    const { default: PowerAlertsPage } = await import('@/app/power-alerts/page')
    const { container } = render(<PowerAlertsPage />)
    expect(container.textContent).toMatch(/Spoken aloud above heat 80 when voice is on; pushed to the desktop above 85/)
  })
})

describe('lib/alertRules', () => {
  test('the channel rules are strict inequalities at their thresholds', async () => {
    const { speechRule, desktopRule } = await import('@/lib/alertRules')
    expect(speechRule(80)).toBeNull()
    expect(speechRule(81)).toBe('heat_score 81 > 80 (SPEAK_ABOVE)')
    expect(desktopRule(85)).toBeNull()
    expect(desktopRule(86)).toBe('heat_score 86 > 85 (PUSH_ABOVE)')
  })

  test('an alert built from a signal with no trigger key carries null, not a guess', async () => {
    const { alertFor } = await import('@/lib/alertRules')
    const e = flow()
    delete (e as Partial<FlowEvent>).alert_trigger
    expect(alertFor(e).trigger).toBeNull()
  })
})
