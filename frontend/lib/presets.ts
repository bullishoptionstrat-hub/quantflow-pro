/**
 * Saved scanner presets — a named `ScannerFilter`, kept in localStorage.
 *
 * Roadmap 5.1: "how a terminal becomes a habit." A preset is client-only on
 * purpose — it is a convenience over the same `POST /api/backtest` a raw filter
 * hits, carries no entitled data, and there is no per-user server table to sync
 * it to (and building one would be a schema change this feature does not need).
 * localStorage is the honest scope: this browser, this origin.
 *
 * Two rules the callers rely on:
 *
 *   - **SSR-safe.** Next renders these pages on the server first, where
 *     `window` does not exist. Every accessor guards on it and returns the
 *     empty result rather than throwing, so a preset list is `[]` during SSR
 *     and hydrates on the client.
 *   - **A corrupt store is empty, not fatal.** A hand-edited or truncated
 *     localStorage value must not white-screen the page. `load` parses
 *     defensively and discards anything that is not a well-formed preset array,
 *     because a preset the code cannot trust is worse than no preset.
 */
import type { ScannerFilter } from './types'

const KEY = 'qf_scanner_presets'

export interface ScannerPreset {
  /** Stable id, used as a React key and for delete/replace. */
  id: string
  /** Human name, unique-cased for the "already exists" check. */
  name: string
  filter: ScannerFilter
  /** Epoch ms the preset was saved. */
  savedAt: number
}

function hasStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage
}

/** One preset, validated field by field. Anything malformed is rejected whole. */
function isPreset(v: unknown): v is ScannerPreset {
  if (!v || typeof v !== 'object') return false
  const p = v as Record<string, unknown>
  return typeof p.id === 'string'
    && typeof p.name === 'string'
    && typeof p.savedAt === 'number'
    && !!p.filter && typeof p.filter === 'object' && !Array.isArray(p.filter)
}

/** Every saved preset, newest first. `[]` during SSR or on a corrupt store. */
export function loadPresets(): ScannerPreset[] {
  if (!hasStorage()) return []
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Drop any element that is not a well-formed preset rather than trusting the
    // array wholesale — a partially-corrupt store still yields its good rows.
    const good = parsed.filter(isPreset)
    return [...good].sort((a, b) => b.savedAt - a.savedAt)
  } catch {
    // A parse failure is a corrupt store, not a crash. The page opens empty.
    return []
  }
}

function write(presets: ScannerPreset[]): ScannerPreset[] {
  if (hasStorage()) {
    window.localStorage.setItem(KEY, JSON.stringify(presets))
  }
  return [...presets].sort((a, b) => b.savedAt - a.savedAt)
}

/**
 * Save a preset under `name`, replacing any existing one with the same name
 * (case-insensitive). Returns the new list.
 *
 * Same-name replacement rather than a silent duplicate: a user re-saving "0DTE
 * SPY sweeps" after tweaking a bound means "update it", and two rows both
 * called that would be a worse habit than the one this feature is trying to
 * build. The id is preserved across a replace so a React key does not churn.
 */
export function savePreset(name: string, filter: ScannerFilter): ScannerPreset[] {
  const trimmed = name.trim()
  if (!trimmed) return loadPresets()
  const existing = loadPresets()
  const prior = existing.find((p) => p.name.toLowerCase() === trimmed.toLowerCase())
  const preset: ScannerPreset = {
    id: prior?.id ?? `preset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: trimmed,
    filter,
    savedAt: Date.now(),
  }
  const rest = existing.filter((p) => p.id !== preset.id)
  return write([preset, ...rest])
}

/** Delete a preset by id. Returns the new list. */
export function deletePreset(id: string): ScannerPreset[] {
  return write(loadPresets().filter((p) => p.id !== id))
}
