/**
 * The 2024 price map, in the two files it survived in.
 *
 * `TopBar`'s copy (SPX 5587, NVDA 942, TSLA 182) was deleted when the tape
 * stopped inventing its prices. Two more were left behind:
 *
 *   - `app/watchlist/page.tsx` held fifteen levels in `SPOT_PRICES` and
 *     rendered them under each ticker in the same monospace as the flow
 *     statistics beside them — the tape's base map with the `Math.random()`
 *     jitter left off.
 *   - `components/calculator/StrategyBuilder.tsx` held eight in `SPOTS` and
 *     priced every Black-Scholes leg off them, read **once** into `useState`'s
 *     initial value, so switching the selected ticker left the previous
 *     underlying's spot and strike in place.
 *
 * A source scan can assert the constants are gone. Only a render can assert
 * that what replaced them shows the feed's price, dates a stale one, and asks
 * for a spot rather than supplying one when the feed has nothing.
 */
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

function mockApi(impl: (path: string) => unknown) {
  vi.doMock('@/lib/apiFetch', () => ({ apiFetch: vi.fn(async (p: string) => impl(p)) }))
}

const quote = (over: Record<string, unknown> = {}) => ({
  symbol: 'SPY', price: 612.4, change: 1.2, changePct: 0.21,
  volume: 1_000, timestamp: Date.now(), source: 'twelvedata', ...over,
})

beforeEach(() => vi.resetModules())
afterEach(() => vi.doUnmock('@/lib/apiFetch'))

async function renderWatchlist(watchlist: string[]) {
  const { useStore } = await import('@/store/useStore')
  useStore.setState({ watchlist, flowEvents: [] } as never)
  const Page = (await import('@/app/watchlist/page')).default
  return render(<Page />)
}

async function renderBuilder(ticker: string) {
  const { useStore } = await import('@/store/useStore')
  useStore.setState({ selectedTicker: ticker } as never)
  const { StrategyBuilder } = await import('@/components/calculator/StrategyBuilder')
  return render(<StrategyBuilder />)
}

describe('watchlist', () => {
  test('a card shows the feed price, not the map', async () => {
    mockApi(() => ok({ quotes: [quote({ symbol: 'NVDA', price: 1_204.55, changePct: -1.37 })] }))
    await renderWatchlist(['NVDA'])

    await waitFor(() => expect(screen.getByText('$1,204.55')).toBeDefined())
    expect(screen.getByText('-1.37%')).toBeDefined()
    // What `SPOT_PRICES` said NVDA was worth.
    expect(screen.queryByText(/\$942/)).toBeNull()
  })

  test('a ticker with no quote gets no price at all', async () => {
    // `SPOT_PRICES` carried MU, MRVL, IWM, GLD and SOXL, none of which the
    // spot connector covers — five entries that could not have been right even
    // in 2024. A ticker the feed does not carry now shows nothing.
    mockApi(() => ok({ quotes: [quote({ symbol: 'SPY' })] }))
    const { container } = await renderWatchlist(['GLD'])

    await waitFor(() => expect(screen.getByText('GLD')).toBeDefined())
    expect(container.textContent).not.toMatch(/\$\d/)
  })

  test('a quote the feed has stopped refreshing is dated, not presented as current', async () => {
    mockApi(() => ok({ quotes: [quote({ symbol: 'SPY', timestamp: Date.now() - 20 * 60_000 })] }))
    await renderWatchlist(['SPY'])
    await waitFor(() => expect(screen.getByText(/AS OF .* ET/)).toBeDefined())
  })

  test('the feed being down is not reported twice', async () => {
    // `TopBar` is mounted in `app/layout.tsx` and already says whether the
    // tape is empty, refused or unreachable, above the fold of this page.
    mockApi(() => ok({ quotes: [] }))
    const { container } = await renderWatchlist(['SPY'])
    await waitFor(() => expect(screen.getByText('SPY')).toBeDefined())
    expect(container.textContent).not.toMatch(/UNREACHABLE|see Settings|REFUSED/i)
  })
})

describe('strategy builder', () => {
  test('the spot seeds from the quote for the selected ticker, and says so', async () => {
    mockApi(() => ok({ quotes: [quote({ symbol: 'NVDA', price: 1_204.55 })] }))
    await renderBuilder('NVDA')

    await waitFor(() => expect(screen.getByText(/FROM NVDA 1,204\.55/)).toBeDefined())
    // The first leg's strike is placed around that spot, not around 942.
    const strike = screen.getAllByDisplayValue('1205')
    expect(strike.length).toBeGreaterThan(0)
  })

  test('no quote means no substitute spot and no leg', async () => {
    // It was `SPOTS[selectedTicker] || 100`: an unknown ticker priced every
    // leg at 100 and said nothing about it.
    mockApi(() => ok({ quotes: [quote({ symbol: 'SPY' })] }))
    const { container } = await renderBuilder('MRVL')

    await waitFor(() => expect(screen.getByText(/NO LIVE QUOTE FOR MRVL/)).toBeDefined())
    expect(screen.getByText(/NO SPOT FOR MRVL/)).toBeDefined()
    expect(container.textContent).not.toMatch(/LEG 1/)
    // And the button that would create one at a made-up strike is not usable.
    expect(screen.getByRole('button', { name: /Add Leg/ }).hasAttribute('disabled')).toBe(true)
  })

  test('a stale quote is dated where it is adopted', async () => {
    mockApi(() => ok({ quotes: [quote({ symbol: 'SPY', timestamp: Date.now() - 20 * 60_000 })] }))
    await renderBuilder('SPY')
    await waitFor(() => expect(screen.getByText(/FROM SPY .* AS OF .* ET/)).toBeDefined())
  })

  test('switching the underlying re-seeds the spot', async () => {
    // `SPOTS` was read once into `useState`'s initial value, so the builder
    // said NVDA at the top and went on pricing SPY underneath.
    mockApi(() => ok({ quotes: [
      quote({ symbol: 'SPY', price: 612.4 }),
      quote({ symbol: 'NVDA', price: 1_204.55 }),
    ] }))
    const { useStore } = await import('@/store/useStore')
    useStore.setState({ selectedTicker: 'SPY' } as never)
    const { StrategyBuilder } = await import('@/components/calculator/StrategyBuilder')
    const { rerender } = render(<StrategyBuilder />)

    await waitFor(() => expect(screen.getByText(/FROM SPY 612\.40/)).toBeDefined())

    act(() => { useStore.setState({ selectedTicker: 'NVDA' } as never) })
    rerender(<StrategyBuilder />)
    await waitFor(() => expect(screen.getByText(/FROM NVDA 1,204\.55/)).toBeDefined())
    expect(screen.queryByText(/FROM SPY/)).toBeNull()
  })
})
