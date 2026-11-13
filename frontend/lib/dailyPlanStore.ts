'use client'
import { useCallback, useEffect, useState } from 'react'
import { isPlan, type DailyPlan } from './dailyPlan'

/**
 * Daily plans live in this browser's localStorage, beside the journal, and
 * under the journal's two failure rules:
 *
 *  - **A store that cannot be read is never overwritten.** If the stored value
 *    will not parse, the page goes read-only and the raw value is left in
 *    place, because the next save would otherwise replace every plan with one.
 *  - **A plan that fails the shape check is counted, not dropped silently.**
 *    It stays in storage (saves keep it) and the page says how many there are.
 *
 * A second plan stored for a date that already has one fails the one-per-date
 * rule, so it is treated the same way: kept, counted, not shown and not read
 * by the ticket. The first one stored is the one that counts.
 */

export const PLAN_STORAGE_KEY = 'quantflow.plans.v1'

export interface LoadedPlans {
  plans: DailyPlan[]
  /** Stored values that failed the shape check or repeat a date. Kept, not shown. */
  rejected: unknown[]
  /** Set when the stored value could not be read at all. Saving is then refused. */
  error: string | null
}

export function parsePlans(raw: string | null): LoadedPlans {
  if (raw === null || raw === '') return { plans: [], rejected: [], error: null }
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (e) {
    return { plans: [], rejected: [], error: `The stored plans could not be read (${(e as Error).message}). They have been left untouched, and saving is off so they are not overwritten.` }
  }
  if (!Array.isArray(data)) {
    return { plans: [], rejected: [], error: 'The stored plans are not a list. They have been left untouched, and saving is off so they are not overwritten.' }
  }
  const plans: DailyPlan[] = []
  const rejected: unknown[] = []
  const dates = new Set<string>()
  for (const v of data) {
    if (isPlan(v) && !dates.has(v.date)) {
      dates.add(v.date)
      plans.push(v)
    } else {
      rejected.push(v)
    }
  }
  return { plans, rejected, error: null }
}

/** Plans plus whatever was rejected, so a save never deletes either. */
export function serializePlans(plans: readonly DailyPlan[], rejected: readonly unknown[]): string {
  return JSON.stringify([...plans, ...rejected])
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function usePlans(): {
  plans: DailyPlan[]
  rejected: number
  error: string | null
  ready: boolean
  /** Apply a change and persist it. Refused while the stored plans are unreadable. */
  update: (fn: (plans: DailyPlan[]) => DailyPlan[]) => string | null
} {
  const [state, setState] = useState<LoadedPlans & { ready: boolean }>({ plans: [], rejected: [], error: null, ready: false })

  useEffect(() => {
    const s = storage()
    if (!s) {
      setState({ plans: [], rejected: [], error: 'This browser does not allow local storage here, so plans cannot be kept.', ready: true })
      return
    }
    let raw: string | null
    try {
      raw = s.getItem(PLAN_STORAGE_KEY)
    } catch (e) {
      setState({ plans: [], rejected: [], error: `Local storage refused the read (${(e as Error).message}).`, ready: true })
      return
    }
    setState({ ...parsePlans(raw), ready: true })
  }, [])

  const update = useCallback((fn: (plans: DailyPlan[]) => DailyPlan[]): string | null => {
    if (!state.ready) return 'The plans have not loaded yet.'
    if (state.error) return state.error
    const s = storage()
    if (!s) return 'Local storage is not available.'
    const next = fn(state.plans)
    try {
      s.setItem(PLAN_STORAGE_KEY, serializePlans(next, state.rejected))
    } catch (e) {
      return `The browser refused to save (${(e as Error).message}). Nothing was changed.`
    }
    setState((cur) => ({ ...cur, plans: next }))
    return null
  }, [state])

  return { plans: state.plans, rejected: state.rejected.length, error: state.error, ready: state.ready, update }
}
