/**
 * Position size from a defined stop, and reward-to-risk net of costs.
 *
 * The arithmetic is short; the rules around it are the point, and each one
 * closes a specific way a sizing tool misleads:
 *
 *  - **Ticks, not points, times tick value.** `stopTicks = |entry − stop| /
 *    tickSize`, then `× tickValue`. Multiplying a stop in points by dollars per
 *    tick under-states NQ risk by 4× and SI by 200×.
 *  - **Never round up to force a trade.** `units = floor(budget / lossPerUnit)`.
 *    When one unit already exceeds the budget the answer is zero, stated as
 *    such, with the micro contract named where one exists.
 *  - **Off-grid prices round the conservative way.** A stop that is not on the
 *    tick grid is rounded to MORE ticks (more risk, fewer units); a target to
 *    FEWER ticks (less reward). Both are reported, never silently applied.
 *  - **Costs and slippage are inputs, never defaults.** A missing cost is not a
 *    zero cost, so an unset field is an error the caller must answer (with 0 if
 *    that is the truth). Slippage is charged on the stop only: a stop is a
 *    market order on the way out, a target is a resting limit. That assumption
 *    is the caller's to change and is stated on the page.
 *  - **R is net.** Reward and risk both carry the round-trip cost, so a gross
 *    2.0R trade with costs is below 2R, and the gate sees the net figure.
 *  - **A partial exit is blended, not ignored.** With several targets the
 *    position is split into whole units per target, and the gate reads the
 *    blended reward of that actual split. A runner to 3R does not make a trade
 *    that takes most of its size off at 1R a 3R trade.
 *  - **The account's risk budget is never invented.** No default dollar figure
 *    exists anywhere in this module or the page that uses it.
 *
 * This sizes ONE idea against ONE stop. It does not know the account's daily
 * loss limit, correlated open risk, or a prop firm's drawdown floor, and it
 * does not pretend to: those are separate constraints and the stricter one
 * wins, which is the trader's decision.
 */

export type Side = 'LONG' | 'SHORT'

export interface SizingSpec {
  tickSize: number
  tickValue: number
  unit: 'contract' | 'share'
  /** Symbol of the smaller contract on the same underlying, if any. */
  micro?: string
}

export interface TargetInput {
  price: number
  /** Fraction of the position exited here, 0..1. Omit for a single target. */
  share?: number
}

export interface SizingInput {
  spec: SizingSpec
  side: Side
  entry: number
  stop: number
  targets: TargetInput[]
  /** Dollars the trader allows this idea to lose. Required; never defaulted. */
  riskBudget: number | null
  /** Round-trip commissions and fees, dollars per unit. Required; 0 is an answer. */
  costPerUnit: number | null
  /** Expected adverse slippage on the stop, in ticks. Required; 0 is an answer. */
  slippageTicks: number | null
  /** Minimum blended net R the idea must offer. */
  minR: number
}

export interface TargetResult {
  price: number
  /** Whole ticks from entry, rounded DOWN when the price is off the tick grid. */
  ticks: number
  offGrid: boolean
  /** Reward to this target before costs, per unit, in R of the gross stop. */
  grossR: number
  /** Dollars per unit if filled here, after the round-trip cost. */
  netRewardPerUnit: number
  /** netRewardPerUnit / lossPerUnit. */
  netR: number
  share: number
  /** Whole units exited here, from the actual split of `units`. */
  units: number
}

export type Verdict =
  | 'INVALID'       // inputs cannot be sized; see errors
  | 'NO_SIZE'       // one unit already risks more than the budget
  | 'NO_TARGET'     // sized, but no target was given, so R cannot be judged
  | 'BELOW_MIN_R'   // sized, but the blended net R is under the minimum
  | 'MEETS_MIN_R'

export interface SizingResult {
  verdict: Verdict
  errors: string[]
  warnings: string[]
  stopPoints: number
  /** Whole ticks to the stop, rounded UP when the stop is off the tick grid. */
  stopTicks: number
  stopOffGrid: boolean
  /** Dollars lost per unit at the stop, including slippage and costs. */
  lossPerUnit: number
  units: number
  /** units × lossPerUnit. Never exceeds the budget. */
  plannedRisk: number
  budgetUnused: number
  targets: TargetResult[]
  /** Total net reward of the actual split / plannedRisk. Null when it cannot be computed. */
  blendedNetR: number | null
}

const GRID_EPS = 1e-6

function finite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n)
}

/** Ticks between two prices, and whether the distance sits on the grid. */
function ticksBetween(a: number, b: number, tickSize: number): { raw: number; onGrid: boolean } {
  const raw = Math.abs(a - b) / tickSize
  return { raw, onGrid: Math.abs(raw - Math.round(raw)) < GRID_EPS }
}

/**
 * Ticks to the stop and dollars lost per unit there, including stop slippage
 * and the round-trip cost. A stop off the tick grid counts as MORE ticks.
 *
 * Exported so the journal measures risk at the actual fill with the same
 * rounding the sizing used, rather than a second copy of the rule.
 */
export function stopRisk(
  tickSize: number, tickValue: number, entry: number, stop: number, slippageTicks: number, costPerUnit: number,
): { stopTicks: number; offGrid: boolean; lossPerUnit: number } {
  const s = ticksBetween(entry, stop, tickSize)
  const stopTicks = s.onGrid ? Math.round(s.raw) : Math.ceil(s.raw)
  return { stopTicks, offGrid: !s.onGrid, lossPerUnit: (stopTicks + slippageTicks) * tickValue + costPerUnit }
}

/**
 * Split `units` across target shares in whole units, by largest remainder, so
 * the parts always sum to `units`. Ties go to the earlier target.
 */
export function splitUnits(units: number, shares: number[]): number[] {
  const exact = shares.map((s) => units * s)
  const base = exact.map((x) => Math.floor(x + GRID_EPS))
  let left = units - base.reduce((a, b) => a + b, 0)
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x + GRID_EPS) }))
    .sort((p, q) => q.frac - p.frac || p.i - q.i)
  for (const { i } of order) {
    if (left <= 0) break
    base[i] = (base[i] ?? 0) + 1
    left--
  }
  return base
}

export function sizePosition(input: SizingInput): SizingResult {
  const errors: string[] = []
  const warnings: string[] = []
  const { spec, side, entry, stop, targets, riskBudget, costPerUnit, slippageTicks, minR } = input

  const empty = (): SizingResult => ({
    verdict: 'INVALID', errors, warnings,
    stopPoints: NaN, stopTicks: NaN, stopOffGrid: false, lossPerUnit: NaN,
    units: 0, plannedRisk: 0, budgetUnused: 0, targets: [], blendedNetR: null,
  })

  if (!finite(spec.tickSize) || spec.tickSize <= 0) errors.push('Tick size must be a positive number.')
  if (!finite(spec.tickValue) || spec.tickValue <= 0) errors.push('Tick value must be a positive number.')
  if (!finite(entry) || entry <= 0) errors.push('Entry must be a positive price.')
  if (!finite(stop) || stop <= 0) errors.push('Stop must be a positive price.')
  if (riskBudget === null || !finite(riskBudget) || riskBudget <= 0) {
    errors.push('Enter the dollar amount this idea may lose. It is never assumed.')
  }
  if (costPerUnit === null || !finite(costPerUnit) || costPerUnit < 0) {
    errors.push('Enter round-trip costs per unit (0 if there are none). A missing cost is not a zero cost.')
  }
  if (slippageTicks === null || !finite(slippageTicks) || slippageTicks < 0) {
    errors.push('Enter expected stop slippage in ticks (0 if none).')
  }
  if (!finite(minR) || minR <= 0) errors.push('Minimum R must be a positive number.')
  if (errors.length) return empty()

  if (stop === entry) errors.push('The stop equals the entry, so the risk per unit is undefined.')
  else if (side === 'LONG' && stop > entry) errors.push('A long stop must be below the entry.')
  else if (side === 'SHORT' && stop < entry) errors.push('A short stop must be above the entry.')

  targets.forEach((t, i) => {
    if (!finite(t.price) || t.price <= 0) errors.push(`TP${i + 1} must be a positive price.`)
    else if (side === 'LONG' && t.price <= entry) errors.push(`TP${i + 1} must be above the entry for a long.`)
    else if (side === 'SHORT' && t.price >= entry) errors.push(`TP${i + 1} must be below the entry for a short.`)
  })

  let shares: number[] = []
  if (targets.length === 1) {
    shares = [targets[0]!.share ?? 1]
    if (Math.abs(shares[0]! - 1) > GRID_EPS) errors.push('A single target exits the whole position; its share must be 100%.')
  } else if (targets.length > 1) {
    shares = targets.map((t) => t.share ?? NaN)
    if (shares.some((s) => !finite(s) || s <= 0 || s > 1)) {
      errors.push('With more than one target, give every target a share between 1% and 100%.')
    } else if (Math.abs(shares.reduce((a, b) => a + b, 0) - 1) > 1e-4) {
      errors.push('Target shares must add up to 100%.')
    }
  }
  if (errors.length) return empty()

  const budget = riskBudget as number
  const cost = costPerUnit as number
  const slip = slippageTicks as number

  const s = stopRisk(spec.tickSize, spec.tickValue, entry, stop, slip, cost)
  const stopTicks = s.stopTicks
  if (s.offGrid) {
    warnings.push(`The stop is off the ${spec.tickSize} tick grid; sized at ${stopTicks} ticks (rounded up, the conservative way).`)
  }
  const stopPoints = stopTicks * spec.tickSize
  const lossPerUnit = s.lossPerUnit

  // Floor, never round. Float division can land a hair under an exact whole
  // number (0.3 / 0.1 is 2.9999999999999996), so a unit is added back only when
  // it fits inside a rounding error of the budget — never when it does not fit.
  let units = Math.max(0, Math.floor(budget / lossPerUnit))
  const tolerance = 1e-9 * Math.max(1, budget)
  if ((units + 1) * lossPerUnit <= budget + tolerance) units += 1
  const plannedRisk = units * lossPerUnit

  const split = units > 0 && targets.length ? splitUnits(units, shares) : shares.map(() => 0)

  const targetResults: TargetResult[] = targets.map((t, i) => {
    const g = ticksBetween(entry, t.price, spec.tickSize)
    const ticks = g.onGrid ? Math.round(g.raw) : Math.floor(g.raw)
    if (!g.onGrid) {
      warnings.push(`TP${i + 1} is off the tick grid; counted at ${ticks} ticks (rounded down, the conservative way).`)
    }
    const netRewardPerUnit = ticks * spec.tickValue - cost
    return {
      price: t.price,
      ticks,
      offGrid: !g.onGrid,
      grossR: ticks / stopTicks,
      netRewardPerUnit,
      netR: netRewardPerUnit / lossPerUnit,
      share: shares[i]!,
      units: split[i] ?? 0,
    }
  })

  targetResults.forEach((t, i) => {
    if (units > 0 && t.units === 0) {
      warnings.push(`At ${units} ${spec.unit}${units === 1 ? '' : 's'}, TP${i + 1}'s ${Math.round(t.share * 100)}% rounds to none; the blended R counts the split that can actually be filled.`)
    }
    if (t.netRewardPerUnit <= 0) {
      warnings.push(`TP${i + 1} does not cover the round-trip cost.`)
    }
  })

  let blendedNetR: number | null = null
  if (units > 0 && targetResults.length) {
    const reward = targetResults.reduce((a, t) => a + t.units * t.netRewardPerUnit, 0)
    blendedNetR = reward / plannedRisk
  }

  let verdict: Verdict
  if (units === 0) {
    verdict = 'NO_SIZE'
    errors.push(
      `One ${spec.unit} risks $${lossPerUnit.toFixed(2)}, more than the $${budget.toFixed(2)} budget. ` +
      (spec.micro ? `Pass, or size it in ${spec.micro}.` : 'Pass, or widen the budget only if the plan allows it.') +
      ' It is not rounded up.',
    )
  } else if (!targetResults.length) {
    verdict = 'NO_TARGET'
  } else {
    verdict = (blendedNetR as number) + 1e-9 >= minR ? 'MEETS_MIN_R' : 'BELOW_MIN_R'
  }

  return {
    verdict, errors, warnings,
    stopPoints, stopTicks, stopOffGrid: s.offGrid, lossPerUnit,
    units, plannedRisk, budgetUnused: Math.max(0, budget - plannedRisk),
    targets: targetResults, blendedNetR,
  }
}
