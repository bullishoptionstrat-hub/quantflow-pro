/**
 * The ticker tape, which used to be the most-seen fabricated data in the app.
 *
 * `TopBar` is mounted in `app/layout.tsx`, so whatever it renders is above the
 * fold of every page. It rendered a hardcoded 2024 price map jittered by
 * `Math.random()`, in the same green and red as the live panels beneath it.
 *
 * A source scan can assert `Math.random` is gone — `wireContract.test.ts` now
 * does. Only a render can assert that what replaced it shows the backend's
 * symbols, says something when there are none, and does not keep painting a
 * three-hour-old price as current.
 */
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

/** Serve a body through the module TopBar actually calls. */
function mockApi(impl: (path: string) => unknown) {
  vi.doMock('@/lib/apiFetch', () => ({ apiFetch: vi.fn(async (p: string) => impl(p)) }))
}

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

const quote = (over: Partial<Record<string, unknown>> = {}) => ({
  symbol: 'SPY', price: 612.4, change: 1.2, changePct: 0.2,
  volume: 1_000, timestamp: Date.now(), source: 'twelvedata', ...over,
})

beforeEach(() => vi.resetModules())
afterEach(() => {
  vi.doUnmock('@/lib/apiFetch')
  vi.useRealTimers()
})

async function renderTape() {
  const { TopBar } = await import('@/components/layout/TopBar')
  return render(<TopBar />)
}

describe('ticker tape', () => {
  test('renders the symbols the backend sent, and only those', async () => {
    // The old `TICKERS` const listed fifteen; the feed covers ten. Seven of
    // them could never have had a price behind them.
    mockApi(() => ok({ quotes: [
      quote({ symbol: 'SPY', price: 612.4, changePct: 0.21 }),
      quote({ symbol: 'NVDA', price: 1_204.55, changePct: -1.37 }),
    ] }))
    await renderTape()

    await waitFor(() => expect(screen.getByText('SPY')).toBeDefined())
    expect(screen.getByText('NVDA')).toBeDefined()
    expect(screen.getByText('$612.40')).toBeDefined()
    expect(screen.getByText('$1,204.55')).toBeDefined()
    expect(screen.getByText('+0.21%')).toBeDefined()
    expect(screen.getByText('-1.37%')).toBeDefined()
    // A symbol from the deleted base map, with no quote behind it.
    expect(screen.queryByText('MSTR')).toBeNull()
  })

  test('an empty feed says so instead of inventing a board', async () => {
    // What a keyless deployment gets: the route answers, with nothing in it.
    mockApi(() => ok({ quotes: [] }))
    await renderTape()
    await waitFor(() => expect(screen.getByText(/NO SPOT FEED REPORTING/i)).toBeDefined())
    // Nothing price-shaped anywhere in the strip. (`TOTAL PREM $0` on the
    // right is the store's own sum over an empty feed, not a quote.)
    expect(screen.queryByText(/^\$[\d,]+\.\d\d$/)).toBeNull()
  })

  test('an unreachable backend is distinguished from an empty one', async () => {
    // Two different problems; "no data" for both sends the reader after the
    // wrong one. Same rule the flow feed's empty states follow.
    mockApi(() => { throw new Error('connection refused') })
    await renderTape()
    await waitFor(() => expect(screen.getByText(/SPOT FEED UNREACHABLE/i)).toBeDefined())
  })

  test('signed out renders an empty strip, not an error', async () => {
    // The tape is in the root layout, so it mounts on /login where there is no
    // session by definition. A red banner there would be noise about nothing.
    mockApi(() => ({ ok: false, status: 401, json: async () => ({ error: 'Unauthorized' }) }))
    await renderTape()
    await waitFor(() => expect(screen.queryByText(/NO SPOT FEED/i)).toBeNull())
    expect(screen.queryByText(/UNREACHABLE/i)).toBeNull()
  })

  test('stale quotes are dated rather than presented as current', async () => {
    // The connector refreshes at worst every 60s. Three hours without a newer
    // quote means the feed stopped — and a stopped feed rendered in the live
    // styling is the defect this whole component was rewritten over.
    const threeHoursAgo = Date.now() - 3 * 60 * 60_000
    mockApi(() => ok({ quotes: [quote({ symbol: 'SPY', timestamp: threeHoursAgo })] }))
    await renderTape()
    await waitFor(() => expect(screen.getByText(/AS OF .* ET/)).toBeDefined())
  })

  test('fresh quotes carry no as-of stamp', async () => {
    mockApi(() => ok({ quotes: [quote({ timestamp: Date.now() - 5_000 })] }))
    await renderTape()
    await waitFor(() => expect(screen.getByText('SPY')).toBeDefined())
    expect(screen.queryByText(/AS OF/)).toBeNull()
  })

  test('a quote with no usable clock is not dated to 1970', async () => {
    // The backend normalizes the two units its cache used to mix; this is the
    // client half of not reading a missing stamp as an epoch-old price.
    mockApi(() => ok({ quotes: [quote({ timestamp: 0 })] }))
    await renderTape()
    await waitFor(() => expect(screen.getByText('SPY')).toBeDefined())
    expect(screen.queryByText(/AS OF/)).toBeNull()
  })
})
