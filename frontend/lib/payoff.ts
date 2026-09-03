import type { StrategyLeg } from './types'

/**
 * What a multi-leg position is actually worth at expiry, and the numbers a
 * builder reports about it.
 *
 * Kept apart from `blackScholes.ts` on purpose: that module values a position
 * *before* expiry under a model, and this one is arithmetic on the payoff
 * itself. The distinction is the one the calculator was missing — its chart
 * was headed **P/L AT EXPIRY** while `computePLCurve` repriced every leg at
 * `T = daysToExpiry / 365`, which is the value today across spot prices, not
 * the payoff at expiry.
 *
 * Every function here reads direction from `leg.action` and treats `leg.qty`
 * as a magnitude. `computePLCurve` used to decide direction with `leg.qty > 0`
 * while the quantity input clamped to `Math.max(1, …)` and `min={1}`, so the
 * test was true for every leg ever built and **`SELL` did nothing at all** —
 * the curve, the max profit, the max loss and the breakeven were identical for
 * a bought and a sold contract.
 */

/** +1 for a long leg, -1 for a short one. */
export function direction(leg: StrategyLeg): 1 | -1 {
  return leg.action === 'BUY' ? 1 : -1
}

/** Contracts, as a count. The sign lives in `action`, and only there. */
export function size(leg: StrategyLeg): number {
  return Math.abs(leg.qty)
}

/** Profit or loss on the whole position if the underlying settles at `S`. */
export function expiryPayoff(legs: StrategyLeg[], S: number): number {
  return legs.reduce((total, leg) => {
    const intrinsic = leg.optionType === 'C'
      ? Math.max(S - leg.strike, 0)
      : Math.max(leg.strike - S, 0)
    return total + direction(leg) * (intrinsic - leg.entryPrice) * 100 * size(leg)
  }, 0)
}

/**
 * Net call contracts, long minus short.
 *
 * The payoff is linear beyond the highest strike with this slope, so it says
 * whether either tail is unbounded — and puts cannot make one, because the
 * underlying stops at zero. A naked short call loses without limit; sampling a
 * fixed 0.70x–1.29x grid and calling `Math.min` on it reports a finite number
 * that is a fact about the grid, not about the position.
 */
export function netCallUnits(legs: StrategyLeg[]): number {
  return legs
    .filter(l => l.optionType === 'C')
    .reduce((n, l) => n + direction(l) * size(l), 0)
}

export interface Extremes {
  /** `null` where the tail is unbounded. */
  maxProfit: number | null
  maxLoss: number | null
}

/**
 * The exact best and worst outcomes at expiry.
 *
 * The payoff is piecewise linear with kinks only at the strikes, so its
 * extremes over a bounded side are attained at `S = 0` or at a strike — no
 * sampling needed, and no dependence on where a plotted range happens to stop.
 */
export function extremes(legs: StrategyLeg[]): Extremes {
  if (legs.length === 0) return { maxProfit: 0, maxLoss: 0 }
  const slope = netCallUnits(legs)
  const candidates = [0, ...legs.map(l => l.strike)]
  const values = candidates.map(S => expiryPayoff(legs, S))
  return {
    maxProfit: slope > 0 ? null : Math.max(...values),
    maxLoss: slope < 0 ? null : Math.min(...values),
  }
}

/**
 * Every underlying price at which the position breaks even at expiry.
 *
 * Exact, because the payoff is piecewise linear: each root is found by
 * interpolating across the segment that contains it. The builder used to read
 * breakevens off sign changes in a 60-point sample of the *model* curve and
 * print the first one as a whole dollar — a grid-resolution guess about a
 * different quantity, reported to the reader as a price. It also printed only
 * the first, which is a wrong answer for a straddle.
 */
export function breakevens(legs: StrategyLeg[]): number[] {
  if (legs.length === 0) return []
  const knots = Array.from(new Set([0, ...legs.map(l => l.strike)])).sort((a, b) => a - b)
  const roots: number[] = []

  for (let i = 0; i < knots.length - 1; i++) {
    const [a, b] = [knots[i], knots[i + 1]]
    const [fa, fb] = [expiryPayoff(legs, a), expiryPayoff(legs, b)]
    if (fa === 0) roots.push(a)
    if (fa * fb < 0) roots.push(a + ((b - a) * -fa) / (fb - fa))
  }

  // The linear tail above the highest strike, where a root can also sit.
  const last = knots[knots.length - 1]
  const fLast = expiryPayoff(legs, last)
  const slope = netCallUnits(legs) * 100
  if (fLast === 0) roots.push(last)
  else if (slope !== 0) {
    const root = last - fLast / slope
    if (root > last) roots.push(root)
  }

  return Array.from(new Set(roots.map(r => Math.round(r * 100) / 100))).sort((a, b) => a - b)
}

export type NetCost =
  /** Nothing paid or received yet — no entry price has been set on any leg. */
  | { kind: 'unset' }
  /** Paid to open. */
  | { kind: 'debit'; amount: number }
  /** Received to open. */
  | { kind: 'credit'; amount: number }
  /** Legs priced, and they net to nothing. */
  | { kind: 'flat' }

/**
 * What the position costs to open.
 *
 * Was `legs.reduce((s, l) => s + l.entryPrice * 100 * l.qty, 0)` — no
 * direction, so a sold leg added to the cost instead of offsetting it — and
 * rendered as `total > 0 ? $total : 'Credit'`. With every entry price at its
 * default of `0`, that printed **Credit** on a long call: an assertion that
 * the reader had been paid to open a position they had paid for. "Nothing
 * entered yet" is a third state, and it was being read as the second.
 */
export function netCost(legs: StrategyLeg[]): NetCost {
  if (legs.length === 0 || legs.every(l => l.entryPrice === 0)) return { kind: 'unset' }
  const net = legs.reduce((s, l) => s + direction(l) * l.entryPrice * 100 * size(l), 0)
  if (Math.abs(net) < 0.005) return { kind: 'flat' }
  return net > 0 ? { kind: 'debit', amount: net } : { kind: 'credit', amount: -net }
}
