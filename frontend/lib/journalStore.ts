'use client'
import { useCallback, useEffect, useState } from 'react'
import { isEntry, type JournalEntry } from './journal'

/**
 * The journal lives in this browser's localStorage, and says so.
 *
 * Two failure rules matter more than the storage itself:
 *  - **A journal that cannot be read is never overwritten.** If the stored
 *    value will not parse, the page goes read-only and the raw value is left
 *    in place, because the next save would otherwise replace someone's trade
 *    history with an empty list.
 *  - **An entry that fails the shape check is counted, not dropped silently.**
 *    It stays in storage (saves keep it) and the page says how many there are.
 */

export const STORAGE_KEY = 'quantflow.journal.v1'

export interface Loaded {
  entries: JournalEntry[]
  /** Stored values that failed the shape check. Kept in storage, not shown. */
  rejected: unknown[]
  /** Set when the stored value could not be read at all. Saving is then refused. */
  error: string | null
}

export function parseJournal(raw: string | null): Loaded {
  if (raw === null || raw === '') return { entries: [], rejected: [], error: null }
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (e) {
    return { entries: [], rejected: [], error: `The stored journal could not be read (${(e as Error).message}). It has been left untouched, and saving is off so it is not overwritten.` }
  }
  if (!Array.isArray(data)) {
    return { entries: [], rejected: [], error: 'The stored journal is not a list of entries. It has been left untouched, and saving is off so it is not overwritten.' }
  }
  const entries: JournalEntry[] = []
  const rejected: unknown[] = []
  for (const v of data) (isEntry(v) ? entries : rejected).push(v as JournalEntry)
  return { entries, rejected, error: null }
}

/** Entries plus whatever failed the shape check, so a save never deletes either. */
export function serializeJournal(entries: readonly JournalEntry[], rejected: readonly unknown[]): string {
  return JSON.stringify([...entries, ...rejected])
}

/**
 * Merge an exported journal into this one. An id already present is skipped,
 * whatever it holds: an import never rewrites an existing entry.
 */
export function mergeImport(current: readonly JournalEntry[], raw: string):
  { entries: JournalEntry[]; added: number; skipped: number; rejected: number } | { error: string } {
  const p = parseJournal(raw)
  if (p.error) return { error: p.error.replace('stored journal', 'imported file').replace(/ It has been left.*$/, '') }
  const have = new Set(current.map((e) => e.id))
  const added = p.entries.filter((e) => !have.has(e.id))
  return { entries: [...current, ...added], added: added.length, skipped: p.entries.length - added.length, rejected: p.rejected.length }
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function useJournal(): {
  entries: JournalEntry[]
  rejected: number
  error: string | null
  ready: boolean
  /** Apply a change and persist it. Refused while the stored journal is unreadable. */
  update: (fn: (entries: JournalEntry[]) => JournalEntry[]) => string | null
} {
  const [state, setState] = useState<Loaded & { ready: boolean }>({ entries: [], rejected: [], error: null, ready: false })

  useEffect(() => {
    const s = storage()
    if (!s) {
      setState({ entries: [], rejected: [], error: 'This browser does not allow local storage here, so the journal cannot be kept.', ready: true })
      return
    }
    let raw: string | null
    try {
      raw = s.getItem(STORAGE_KEY)
    } catch (e) {
      setState({ entries: [], rejected: [], error: `Local storage refused the read (${(e as Error).message}).`, ready: true })
      return
    }
    setState({ ...parseJournal(raw), ready: true })
  }, [])

  const update = useCallback((fn: (entries: JournalEntry[]) => JournalEntry[]): string | null => {
    if (!state.ready) return 'The journal has not loaded yet.'
    if (state.error) return state.error
    const s = storage()
    if (!s) return 'Local storage is not available.'
    const next = fn(state.entries)
    try {
      s.setItem(STORAGE_KEY, serializeJournal(next, state.rejected))
    } catch (e) {
      return `The browser refused to save (${(e as Error).message}). Nothing was changed.`
    }
    setState((cur) => ({ ...cur, entries: next }))
    return null
  }, [state])

  return { entries: state.entries, rejected: state.rejected.length, error: state.error, ready: state.ready, update }
}
