/**
 * A display filter was deleting the tape.
 *
 * `useFlowFeed.handleEvent` began `if (!passesFilters(event)) return`, so the
 * store held only what matched the filters **at the moment each signal
 * arrived**. The filters are a view control the reader moves: raising
 * `minPremium` to $1M for a minute and putting it back deleted every sub-$1M
 * print from that minute, permanently, while the control on screen said they
 * were admitted again.
 *
 * The predicate was written out twice — once at ingest, once in `FlowFeed` for
 * display — so the display copy re-filtered an already-filtered set and was a
 * no-op for anything but a narrowing. It was dead code guarding against a loss
 * the other copy had already caused.
 *
 * A source scan cannot catch this: both copies are correct in isolation, and
 * the damage is in the order the store and the filter run in. Only feeding
 * events through the real hook and then widening a filter shows it.
 */
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { matchesFilters, isPowerAlert } from '@/lib/flowFilter'
import type { FlowEvent } from '@/lib/types'

/**
 * The store from the *current* module registry.
 *
 * `vi.resetModules()` between tests gives each one its own copy of the module
 * graph, so a statically imported store is a different singleton from the one
 * the dynamically imported hook and component use.
 */
async function store() {
  return (await import('@/store/useStore')).useStore
}

const BASE_FILTERS = {
  ticker: '', minPremium: 25_000, optionType: 'ALL', orderType: 'ALL',
  sentiment: 'ALL', minHeat: 0, unusualOnly: false,
}

/** The socket the hook subscribes to, captured so a test can push batches. */
let emit: ((batch: FlowEvent[]) => void) | null = null

function mockSocket() {
  vi.doMock('@/lib/socket', () => ({
    getSocket: () => ({
      on: (event: string, cb: (b: FlowEvent[]) => void) => {
        if (event === 'flow_batch') emit = cb
      },
      off: () => {},
    }),
  }))
}

const flow = (o: Partial<FlowEvent> = {}): FlowEvent => ({
  id: `e${Math.random()}`,
  underlying: 'SPY', option_type: 'C', order_type: 'SWEEP',
  strike: 610, expiry: '2026-10-16',
  total_premium: 50_000, total_size: 100,
  heat_score: 50, sentiment: 'BULLISH', side: 'BUY',
  is_unusual: false, synthetic: false,
  created_at: new Date().toISOString(),
  ...o,
} as FlowEvent)

beforeEach(async () => {
  vi.resetModules()
  emit = null
  ;(await store()).setState({
    flowEvents: [], powerAlerts: [], connected: false, voiceEnabled: false,
    filters: { ...BASE_FILTERS },
  } as never)
})
afterEach(() => vi.doUnmock('@/lib/socket'))

/** Mount the real feed and wait for the socket subscription. */
async function mountFeed() {
  mockSocket()
  const { useFlowFeed } = await import('@/hooks/useFlowFeed')
  function Probe() { useFlowFeed(); return null }
  render(<Probe />)
  await act(async () => {})
  expect(emit).not.toBeNull()
}

async function send(events: FlowEvent[]) {
  await act(async () => { emit!(events) })
}

describe('the filters no longer decide what is kept', () => {
  test('a signal excluded by the filters is still stored', async () => {
    await mountFeed()
    const s = await store()
    s.setState({ filters: { ...BASE_FILTERS, minPremium: 1_000_000 } } as never)

    await send([flow({ id: 'small', total_premium: 40_000 })])

    // It used to be dropped here and unrecoverable.
    expect(s.getState().flowEvents.map(e => e.id)).toContain('small')
  })

  test('widening a filter brings the signals back', async () => {
    // The failure this PR exists for: narrow, receive, widen. Before, the
    // signals received while narrowed were gone for good.
    await mountFeed()
    const s = await store()
    s.setState({ filters: { ...BASE_FILTERS, minPremium: 1_000_000 } } as never)
    await send([flow({ id: 'a', total_premium: 40_000 }), flow({ id: 'b', total_premium: 2_000_000 })])

    const narrowed = s.getState().flowEvents.filter(e => matchesFilters(e, s.getState().filters))
    expect(narrowed.map(e => e.id)).toEqual(['b'])

    s.setState({ filters: { ...BASE_FILTERS, minPremium: 25_000 } } as never)
    const widened = s.getState().flowEvents.filter(e => matchesFilters(e, s.getState().filters))
    expect(widened.map(e => e.id).sort()).toEqual(['a', 'b'])
  })
})

describe('alerts follow the market, not the view', () => {
  test('a filtered-out signal still raises its alert', async () => {
    // Choosing to look at puts used to stop the terminal announcing a call
    // sweep — a view control with a side effect on an out-of-band channel.
    await mountFeed()
    const s = await store()
    s.setState({ filters: { ...BASE_FILTERS, optionType: 'P' } } as never)

    await send([flow({ id: 'call', option_type: 'C', is_unusual: true, heat_score: 90 })])

    expect(s.getState().powerAlerts.map(a => a.flow_event_id)).toContain('call')
  })

  test('the alert criteria are unusual and heat, and nothing else', () => {
    expect(isPowerAlert(flow({ is_unusual: true, heat_score: 75 }))).toBe(true)
    expect(isPowerAlert(flow({ is_unusual: true, heat_score: 74 }))).toBe(false)
    // A sweep on its own is not an alert, whatever the page used to claim.
    expect(isPowerAlert(flow({ is_unusual: false, heat_score: 99, order_type: 'SWEEP' }))).toBe(false)
  })

  test('an alert carries the order type that raised it', async () => {
    // `alert_type` was assigned `event.order_type as any` against a union that
    // did not contain SPLIT, MULTI_LEG or LARGE.
    await mountFeed()
    await send([flow({ id: 'ml', order_type: 'MULTI_LEG', is_unusual: true, heat_score: 88 })])
    expect((await store()).getState().powerAlerts[0].alert_type).toBe('MULTI_LEG')
  })
})

describe('the stat tiles say what they are over', () => {
  async function renderStats(flowEvents: FlowEvent[]) {
    ;(await store()).setState({ flowEvents } as never)
    const { FlowStats } = await import('@/components/flow/FlowStats')
    return render(<FlowStats />)
  }

  test('nothing is labelled TOTAL, and the window is stated', async () => {
    const { container } = await renderStats([
      flow({ created_at: new Date(Date.now() - 90_000).toISOString() }),
      flow({ created_at: new Date().toISOString() }),
    ])

    expect(container.textContent).not.toMatch(/TOTAL/)
    expect(container.textContent).toMatch(/over the 2 signals received this session/)
    expect(container.textContent).toMatch(/spanning 1m 30s/)
  })

  test('a full window says older signals have dropped off', async () => {
    const { container } = await renderStats(Array.from({ length: 500 }, () => flow()))
    expect(container.textContent).toMatch(/window full at 500/)
  })

  test('simulated prints are counted where the aggregate mixes them', async () => {
    // The feed marks them per row; an aggregate that pools them has to say so.
    const { container } = await renderStats([flow({ synthetic: true }), flow()])
    expect(container.textContent).toMatch(/1 simulated/)
  })

  test('an all-put tape is not coloured green', async () => {
    // `Number('—') > 1` is false, so the most bearish tape there is came out
    // in the bullish colour.
    const { container } = await renderStats([flow({ option_type: 'P', total_premium: 1e6 })])
    const tile = Array.from(container.querySelectorAll('.card'))
      .find(c => c.textContent?.includes('PUT/CALL $'))!
    expect(tile.textContent).toMatch(/—/)
    expect(tile.innerHTML).not.toMatch(/#22c55e/)
  })

  test('the ratio names its basis', async () => {
    // Three quantities shared the label `P/C RATIO`: this one (premium), the
    // backend's count ratio, and the macro page's Cboe exchange volume.
    const { container } = await renderStats([
      flow({ option_type: 'C', total_premium: 1e6 }),
      flow({ option_type: 'P', total_premium: 2e6 }),
    ])
    expect(container.textContent).toMatch(/PUT\/CALL \$/)
    expect(container.textContent).toMatch(/2\.00/)
    expect(container.textContent).not.toMatch(/P\/C RATIO/)
  })
})
