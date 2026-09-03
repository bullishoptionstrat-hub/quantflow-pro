/**
 * Selling was a no-op, and a bought call was shown with no downside.
 *
 * `computePLCurve` decided a leg's direction with `leg.qty > 0`, while the
 * quantity input clamped to `Math.max(1, …)` with `min={1}` — so the test was
 * true for every leg that could be built and the `ACTION` select changed
 * nothing. A sold contract produced a byte-identical curve to a bought one,
 * and with it an identical max profit, max loss and breakeven.
 *
 * On top of that, `entryPrice` defaulted to `0`, so the curve was the
 * position's *value*, not its P/L. At the calculator's own defaults a long
 * call reported **MAX PROFIT $18,252, MAX LOSS $0, BREAKEVEN —** and
 * **PREMIUM PAID: Credit**: no downside on a position that costs $2,346, and
 * an assertion that the reader had been paid to open it.
 *
 * The chart was also headed **P/L AT EXPIRY** while plotting `T = dte/365`,
 * which is the model value today across spot prices.
 */
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { computePLCurve } from '@/lib/blackScholes'
import { expiryPayoff, extremes, breakevens, netCost } from '@/lib/payoff'
import type { StrategyLeg } from '@/lib/types'

const leg = (o: Partial<StrategyLeg> = {}): StrategyLeg => ({
  optionType: 'C', action: 'BUY', strike: 610, expiry: '2026-10-03',
  iv: 30, entryPrice: 23.46, qty: 1, ...o,
})

describe('direction comes from action', () => {
  test('a sold leg is not the same position as a bought one', () => {
    const spot = 612.4
    const range = Array.from({ length: 20 }, (_, i) => spot * (0.8 + i * 0.02))
    const bought = computePLCurve([leg()], range, 30, 0.05)
    const sold = computePLCurve([leg({ action: 'SELL' })], range, 30, 0.05)
    expect(bought).not.toEqual(sold)
    // Exactly opposed, which is what the two sides of one contract are.
    bought.forEach((v, i) => expect(sold[i]).toBeCloseTo(-v, 6))
  })

  test('quantity is a magnitude, and scales without changing sign', () => {
    const one = expiryPayoff([leg()], 700)
    const three = expiryPayoff([leg({ qty: 3 })], 700)
    expect(three).toBeCloseTo(one * 3, 6)
    // The old code read direction off `qty`; a negative one must not now mean
    // "short" as well, or there would be two ways to say it.
    expect(expiryPayoff([leg({ qty: -3 })], 700)).toBeCloseTo(one * 3, 6)
  })
})

describe('the extremes are the position, not the plotted range', () => {
  test('a long call risks its premium and no more', () => {
    // It reported $0.
    expect(extremes([leg()])).toEqual({ maxProfit: null, maxLoss: -2346 })
  })

  test('a naked short call loses without limit', () => {
    // `Math.min` over a 0.70x-1.29x sample reported a finite number, which was
    // a fact about where the range stopped.
    expect(extremes([leg({ action: 'SELL' })])).toEqual({ maxProfit: 2346, maxLoss: null })
  })

  test('a spread is bounded on both sides', () => {
    const spread = [leg({ strike: 610, entryPrice: 23.46 }), leg({ strike: 640, action: 'SELL', entryPrice: 9.46 })]
    const { maxProfit, maxLoss } = extremes(spread)
    expect(maxProfit).toBeCloseTo((640 - 610 - 14) * 100, 6)
    expect(maxLoss).toBeCloseTo(-14 * 100, 6)
  })
})

describe('breakevens are solved, not sampled', () => {
  test('a long call breaks even at strike plus premium', () => {
    // Read off sign changes in a 60-point grid before, and rounded to whole
    // dollars — a grid-resolution guess printed as a price.
    expect(breakevens([leg()])).toEqual([633.46])
  })

  test('a straddle has two, and both are reported', () => {
    // The tile printed `breakevens[0]`, which is a wrong answer here.
    const straddle = [leg(), leg({ optionType: 'P', entryPrice: 20 })]
    expect(breakevens(straddle)).toEqual([566.54, 653.46])
  })

  test('a position that cannot break even reports none', () => {
    // Bought and sold the same contract at different prices: the payoff is a
    // flat -$1,000 everywhere, and there is no price at which it is zero.
    const locked = [leg({ entryPrice: 30 }), leg({ action: 'SELL', entryPrice: 20 })]
    expect(expiryPayoff(locked, 400)).toBeCloseTo(-1000, 6)
    expect(expiryPayoff(locked, 900)).toBeCloseTo(-1000, 6)
    expect(breakevens(locked)).toEqual([])
    expect(breakevens([])).toEqual([])
  })
})

describe('net cost has three states', () => {
  test('paid, received, and nothing entered yet', () => {
    expect(netCost([leg()])).toEqual({ kind: 'debit', amount: 2346 })
    expect(netCost([leg({ action: 'SELL' })])).toEqual({ kind: 'credit', amount: 2346 })
    // The state the tile was reading as a credit.
    expect(netCost([leg({ entryPrice: 0 })])).toEqual({ kind: 'unset' })
  })

  test('a sold leg offsets a bought one instead of adding to it', () => {
    // `s + l.entryPrice * 100 * l.qty` had no direction in it at all.
    const spread = [leg({ entryPrice: 23.46 }), leg({ strike: 640, action: 'SELL', entryPrice: 9.46 })]
    expect(netCost(spread)).toEqual({ kind: 'debit', amount: 1400 })
  })
})

// ─── The builder, rendered ──────────────────────────────────────────────────

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
const quote = (o: Record<string, unknown> = {}) => ({
  symbol: 'SPY', price: 612.4, change: 1.2, changePct: 0.21,
  volume: 1_000, timestamp: Date.now(), source: 'twelvedata', ...o,
})

function mockApi(impl: (path: string) => unknown) {
  vi.doMock('@/lib/apiFetch', () => ({ apiFetch: vi.fn(async (p: string) => impl(p)) }))
}

beforeEach(() => vi.resetModules())
afterEach(() => vi.doUnmock('@/lib/apiFetch'))

async function renderBuilder() {
  mockApi(() => ok({ quotes: [quote()] }))
  const { useStore } = await import('@/store/useStore')
  useStore.setState({ selectedTicker: 'SPY' } as never)
  const { StrategyBuilder } = await import('@/components/calculator/StrategyBuilder')
  const view = render(<StrategyBuilder />)
  // Wait for the seeded leg, not for the label. `FROM SPY` renders as soon as
  // the quote arrives, which is one render before the effect that adopts it
  // sets the spot and creates the first leg — so waiting on the label returns
  // in a window where the position does not exist yet, and every assertion
  // after it is a race. (This suite runs `singleFork`, so the window is only
  // sometimes wide enough to lose.)
  await waitFor(() => expect(screen.getByText(/debit|credit/)).toBeDefined())
  expect(screen.getByText(/FROM SPY/)).toBeDefined()
  return view
}

describe('the default screen', () => {
  test('a bought call does not report a zero max loss or a credit', async () => {
    const { container } = await renderBuilder()
    expect(container.textContent).not.toMatch(/\$\(0\)|Credit/)
    expect(screen.getByText(/debit/)).toBeDefined()
    // Unbounded upside is said, not sampled into a finite number.
    expect(screen.getByText('∞')).toBeDefined()
  })

  test('the entry price says it came from the model', async () => {
    // `ENTRY $` reads as what you paid. A model price sitting in it has to say
    // so, the same way the spot field names where its number came from.
    await renderBuilder()
    expect(screen.getByText(/MODEL/)).toBeDefined()
  })

  test('a breakeven is reported, because the position now has a cost', async () => {
    // With `entryPrice: 0` the curve never crossed zero and the tile read `—`.
    const { container } = await renderBuilder()
    expect(container.textContent).toMatch(/BREAKEVEN\$[\d,]+\.\d\d/)
  })
})

describe('the chart says what it draws', () => {
  test('both series are named, and the heading no longer claims one is the other', async () => {
    const { container } = await renderBuilder()
    expect(container.textContent).toMatch(/at expiry/)
    expect(container.textContent).toMatch(/today \(30d out\)/)
    expect(container.textContent).not.toMatch(/P\/L AT EXPIRY/)
  })

  test('the assumed interest rate is on screen', async () => {
    await renderBuilder()
    expect(screen.getByText(/RISK-FREE \(assumed\): 5%/)).toBeDefined()
  })
})

describe('selecting SELL changes the position', () => {
  test('it flips the reported risk', async () => {
    const { container } = await renderBuilder()
    expect(container.textContent).toMatch(/debit/)

    const action = screen.getByDisplayValue('BUY')
    fireEvent.change(action, { target: { value: 'SELL' } })

    await waitFor(() => expect(container.textContent).toMatch(/credit/))
    // Unbounded loss, where the bought position had unbounded profit.
    expect(container.textContent).toMatch(/-∞/)
  })
})
