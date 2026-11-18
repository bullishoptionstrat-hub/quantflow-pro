/**
 * Post-trade review: the frozen ticket set beside what the journal recorded.
 *
 * Every figure comes from the journal entry alone (its ticket record, fill,
 * exits, fees and moved stop) and from `evaluateEntry`, so R, outcome and
 * process are the journal's own numbers, not a second computation. Anything
 * not recorded is null and the row says so; nothing is assumed.
 *
 * Slippage is signed against the trader: positive ticks means the fill (or
 * average exit) was worse than planned for the direction, negative better.
 * The process/outcome quadrant only exists when both halves are measured.
 */
import { evaluateEntry, type JournalEntry } from './journal'

export interface ReviewRow {
  label: string
  planned: number | null
  actual: number | null
  /** Ticks against the trader (positive = worse). Null when either side is missing. */
  adverseTicks: number | null
  note: string | null
}

export type Quadrant = 'EARNED' | 'GOOD_LOSS' | 'LUCKY' | 'DESERVED'

export interface PostTradeReview {
  rows: ReviewRow[]
  plannedR: number | null
  realizedR: number | null
  plannedCost: number | null
  actualFees: number | null
  outcome: 'WIN' | 'LOSS' | 'BREAKEVEN' | null
  process: 'CLEAN' | 'VIOLATION' | 'UNREVIEWED' | null
  quadrant: Quadrant | null
  violations: string[]
  /** The trader's one repeat/avoid action, trimmed; null when not written. */
  nextAction: string | null
}

const fin = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

function adverse(e: JournalEntry, planned: number | null, actual: number | null, kind: 'entry' | 'exit' | 'stop'): number | null {
  const side = e.ticket.direction
  if (!fin(planned) || !fin(actual) || side === null || !(e.spec.tickSize > 0)) return null
  const sign = side === 'LONG' ? 1 : -1
  // Entry: paying more (long) is worse. Exit: receiving less (long) is worse.
  // Stop: a stop further from entry (lower, for a long) is worse.
  const diff = kind === 'entry' ? (actual - planned) * sign : (planned - actual) * sign
  return Math.round((diff / e.spec.tickSize) * 1e6) / 1e6
}

export function quadrantOf(process: PostTradeReview['process'], outcome: PostTradeReview['outcome']): Quadrant | null {
  if (process === null || process === 'UNREVIEWED' || outcome === null || outcome === 'BREAKEVEN') return null
  if (process === 'CLEAN') return outcome === 'WIN' ? 'EARNED' : 'GOOD_LOSS'
  return outcome === 'WIN' ? 'LUCKY' : 'DESERVED'
}

export function postTradeReview(e: JournalEntry, all: readonly JournalEntry[]): PostTradeReview {
  const ev = evaluateEntry(e, all)
  const plan = e.ticket.plan
  const rows: ReviewRow[] = []

  const fillPrice = e.fill ? e.fill.price : null
  rows.push({ label: 'ENTRY', planned: plan.entry, actual: fillPrice, adverseTicks: adverse(e, plan.entry, fillPrice, 'entry'),
    note: fillPrice === null ? 'no fill recorded' : null })

  const stopActual = e.actualStop ?? (e.fill ? plan.stop : null)
  rows.push({ label: 'STOP', planned: plan.stop, actual: stopActual, adverseTicks: adverse(e, plan.stop, stopActual, 'stop'),
    note: e.actualStop === null ? (e.fill ? 'not moved' : 'no fill recorded') : 'moved' })

  rows.push({ label: 'UNITS', planned: plan.units, actual: e.fill ? e.fill.units : null, adverseTicks: null,
    note: e.fill === null ? 'no fill recorded' : null })

  const outUnits = e.exits.reduce((a, x) => a + x.units, 0)
  const avgExit = outUnits > 0 ? e.exits.reduce((a, x) => a + x.price * x.units, 0) / outUnits : null
  const tgts = plan.targets.filter((t) => fin(t.price) && fin(t.units))
  const tUnits = tgts.reduce((a, t) => a + (t.units as number), 0)
  const avgTarget = tUnits > 0 ? tgts.reduce((a, t) => a + (t.price as number) * (t.units as number), 0) / tUnits : null
  rows.push({ label: 'AVG EXIT vs TARGETS', planned: avgTarget, actual: avgExit, adverseTicks: adverse(e, avgTarget, avgExit, 'exit'),
    note: avgExit === null ? 'no exit recorded' : avgTarget === null ? 'ticket had no sized targets' : null })

  const plannedCost = fin(plan.costPerUnit) && fin(plan.units) ? plan.costPerUnit * plan.units : null
  return {
    rows,
    plannedR: fin(plan.blendedNetR) ? plan.blendedNetR : null,
    realizedR: ev.realized?.r ?? null,
    plannedCost,
    actualFees: e.fees,
    outcome: ev.outcome,
    process: ev.process,
    quadrant: quadrantOf(ev.process, ev.outcome),
    violations: [...ev.autoTags, ...e.tags],
    nextAction: e.review.nextAction.trim() || null,
  }
}

export const QUADRANT_TEXT: Record<Quadrant, string> = {
  EARNED: 'clean process, winning outcome',
  GOOD_LOSS: 'clean process, losing outcome — a loss the plan allowed',
  LUCKY: 'rules broken, winning outcome — do not repeat',
  DESERVED: 'rules broken, losing outcome',
}
