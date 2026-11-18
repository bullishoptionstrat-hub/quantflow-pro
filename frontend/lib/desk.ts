/**
 * What the desk overview says about today's risk, and nothing it cannot back.
 *
 * The lock status has three states because there are three facts:
 *
 *  - **LOCKED** — something measured here locks the day: the journal's
 *    stop-outs reach `STOP_OUT_LOCK`, or the day's realized loss or attempts
 *    reach what today's plan wrote. The reasons are `dailyLockReasons`, the
 *    same function the ticket's daily-lock gate reads, so the desk and the
 *    ticket cannot disagree about whether the day is locked.
 *  - **CLEAR** — every limit that could lock the day is written and was
 *    measured, and none is reached.
 *  - **UNKNOWN** — the date, the journal, or a written limit is missing, so
 *    "not locked" cannot be established. A plan with no loss limit is not a
 *    day with no loss limit.
 *
 * CLEAR is still not permission: the ticket's daily-lock gate is the trader's
 * own answer too, and nothing here answers it.
 */
import { dailyLockReasons, STOP_OUT_LOCK, type PlanContext } from './tradeTicket'
import type { JournalEntry } from './journal'

export type DeskLockState = 'LOCKED' | 'CLEAR' | 'UNKNOWN'

export interface DeskLock {
  state: DeskLockState
  reasons: string[]
}

export function deskLock(date: string | null, stopOuts: number | null, plan: PlanContext): DeskLock {
  if (date === null) {
    return { state: 'UNKNOWN', reasons: ["Today's ET date is unknown: the backend has not answered."] }
  }
  if (stopOuts === null) {
    return { state: 'UNKNOWN', reasons: ['The journal in this browser could not be read, so the day\'s losses and attempts are unknown.'] }
  }
  const reasons = dailyLockReasons({ priorAttempts: 0, stopOutsToday: stopOuts }, plan)
  if (reasons.length) return { state: 'LOCKED', reasons }
  if (plan.status !== 'WRITTEN') {
    return { state: 'UNKNOWN', reasons: [`No plan is written for ${date}, so there is no loss limit or maximum attempts to measure. Stop-outs ${stopOuts} of ${STOP_OUT_LOCK}.`] }
  }
  const unwritten: string[] = []
  if (plan.lossLimit === null) unwritten.push('loss limit')
  if (plan.maxAttempts === null) unwritten.push('maximum attempts')
  if (unwritten.length) {
    return { state: 'UNKNOWN', reasons: [`Today's plan has no ${unwritten.join(' or ')} written, so "not locked" cannot be established.`] }
  }
  if (plan.day === null) {
    return { state: 'UNKNOWN', reasons: ['The journal could not be read, so the day\'s loss and attempts are unknown.'] }
  }
  return { state: 'CLEAR', reasons: ['No written limit is reached. The ticket\'s daily-lock gate is still your own answer.'] }
}

/** The most recently saved journal entry, whose frozen ticket is the latest saved ticket. */
export function latestTicket(entries: readonly JournalEntry[]): JournalEntry | null {
  let best: JournalEntry | null = null
  for (const e of entries) if (best === null || e.savedAt > best.savedAt) best = e
  return best
}

/** `2 h 05 min`, `42 min`, `under 1 min`. */
export function minutesText(m: number): string {
  if (m < 1) return 'under 1 min'
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`
}
