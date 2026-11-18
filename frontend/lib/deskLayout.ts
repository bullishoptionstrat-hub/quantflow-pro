'use client'
import { useCallback, useEffect, useState } from 'react'

/**
 * Which `/desk` panels are shown, kept in this browser's localStorage.
 *
 * Same rules as the journal (`journalStore.ts`):
 *  - **An unreadable stored layout is never overwritten.** The desk shows every
 *    panel, says the layout could not be read, and refuses to save.
 *  - **An id this version does not know is kept**, so a layout written by a
 *    newer build is not trimmed by an older one.
 *
 * One panel cannot be hidden: **Risk state**, because it carries the daily
 * lock. A layout is a view preference, and a view preference must never be
 * able to take the lock off the screen. A stored layout that hides it is read
 * with the lock shown anyway.
 */

export const DESK_LAYOUT_KEY = 'quantflow.desk.layout.v1'

export const DESK_PANELS = [
  { id: 'session', title: 'Session' },
  { id: 'risk', title: 'Risk state' },
  { id: 'ticket', title: 'Latest ticket' },
  { id: 'plan', title: "Today's plan" },
  { id: 'events', title: 'Stand-aside windows' },
  { id: 'gex', title: 'GEX reference' },
  { id: 'sources', title: 'Sources' },
] as const
export type DeskPanelId = (typeof DESK_PANELS)[number]['id']

/** Panels a layout can never hide. */
export const ALWAYS_SHOWN: readonly DeskPanelId[] = ['risk']

export interface DeskLayout {
  hidden: DeskPanelId[]
  /** Hidden ids this version does not know. Kept on save, not acted on. */
  unknown: string[]
  error: string | null
}

const KNOWN = new Set<string>(DESK_PANELS.map((p) => p.id))

export function parseDeskLayout(raw: string | null): DeskLayout {
  if (raw === null || raw === '') return { hidden: [], unknown: [], error: null }
  const refuse = (why: string): DeskLayout => ({
    hidden: [], unknown: [],
    error: `The saved desk layout ${why}. Every panel is shown, the saved value is left untouched, and layout changes are not saved.`,
  })
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return refuse('could not be read')
  }
  if (typeof data !== 'object' || data === null) return refuse('is not a layout')
  const h = (data as Record<string, unknown>).hidden
  if (!Array.isArray(h) || !h.every((x) => typeof x === 'string')) return refuse('has no list of hidden panels')
  const hidden: DeskPanelId[] = []
  const unknown: string[] = []
  for (const id of Array.from(new Set(h as string[]))) {
    if (!KNOWN.has(id)) unknown.push(id)
    else if (!ALWAYS_SHOWN.includes(id as DeskPanelId)) hidden.push(id as DeskPanelId)
  }
  return { hidden, unknown, error: null }
}

export function serializeDeskLayout(hidden: readonly DeskPanelId[], unknown: readonly string[]): string {
  return JSON.stringify({ hidden: [...hidden.filter((id) => !ALWAYS_SHOWN.includes(id)), ...unknown] })
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function useDeskLayout(): {
  hidden: ReadonlySet<DeskPanelId>
  error: string | null
  /** Show or hide one panel. Returns a reason when nothing was saved. */
  toggle: (id: DeskPanelId) => string | null
} {
  const [state, setState] = useState<DeskLayout & { ready: boolean }>({ hidden: [], unknown: [], error: null, ready: false })

  useEffect(() => {
    const s = storage()
    if (!s) {
      setState({ hidden: [], unknown: [], error: 'This browser does not allow local storage here, so the desk layout cannot be kept.', ready: true })
      return
    }
    let raw: string | null
    try {
      raw = s.getItem(DESK_LAYOUT_KEY)
    } catch {
      setState({ hidden: [], unknown: [], error: 'Local storage refused the read, so the desk layout cannot be kept.', ready: true })
      return
    }
    setState({ ...parseDeskLayout(raw), ready: true })
  }, [])

  const toggle = useCallback((id: DeskPanelId): string | null => {
    if (ALWAYS_SHOWN.includes(id)) return 'This panel carries the daily lock and is always shown.'
    if (!state.ready) return 'The layout has not loaded yet.'
    if (state.error) return state.error
    const s = storage()
    if (!s) return 'Local storage is not available.'
    const next = state.hidden.includes(id) ? state.hidden.filter((x) => x !== id) : [...state.hidden, id]
    try {
      s.setItem(DESK_LAYOUT_KEY, serializeDeskLayout(next, state.unknown))
    } catch {
      return 'The browser refused to save the layout. Nothing was changed.'
    }
    setState((cur) => ({ ...cur, hidden: next }))
    return null
  }, [state])

  return { hidden: new Set(state.hidden), error: state.error, toggle }
}
