/**
 * What the sidebar may say about the data sources, from `/api/health` alone.
 *
 * The sidebar used to print CBOE, FRED, CRYPTO, REDDIT, NEWS and STOOQ as
 * green tags on every deployment. Those six were a hand-written list with no
 * status behind it: a keyless deployment showed FRED, Reddit and NewsAPI as
 * green while the backend reported them `disabled`, and Stooq and CoinGecko
 * green while it reported `error`.
 *
 * This counts every source the backend reports, in the backend's own states,
 * so a source added to or removed from ingestion changes the count without a
 * frontend edit. The words are the backend's: `connected` means the connector
 * ran and its last cycle succeeded, not that its data is fresh, so it is never
 * relabelled LIVE here. A `connected` source carrying a note is `degraded`,
 * the same rule as the settings page. The simulator is reported separately: a
 * running simulator is not a working market-data source, and counting it among
 * the connected ones would inflate exactly the number a reader trusts.
 */
export type SourceState = 'connected' | 'degraded' | 'error' | 'refused' | 'disabled' | 'unknown'

export interface SourceSummary {
  /** Source names in each state, sorted. */
  byState: Record<SourceState, string[]>
  /** Whether the backend's simulator is generating prints. */
  simulation: boolean
}

const KNOWN = new Set(['connected', 'error', 'refused', 'disabled'])

export function summariseSources(body: unknown): SourceSummary | null {
  const ingestion = (body as { ingestion?: unknown } | null)?.ingestion as
    | { sources?: unknown; sourceNotes?: unknown }
    | undefined
  const sources = ingestion?.sources
  // No map at all is "the backend did not say", not "no sources".
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)) return null
  const notes = (ingestion?.sourceNotes && typeof ingestion.sourceNotes === 'object'
    ? ingestion.sourceNotes : {}) as Record<string, unknown>

  const byState: Record<SourceState, string[]> = {
    connected: [], degraded: [], error: [], refused: [], disabled: [], unknown: [],
  }
  let simulation = false
  for (const [name, raw] of Object.entries(sources as Record<string, unknown>)) {
    if (name === 'simulation') {
      simulation = raw === 'connected'
      continue
    }
    let state: SourceState = typeof raw === 'string' && KNOWN.has(raw) ? (raw as SourceState) : 'unknown'
    if (state === 'connected' && typeof notes[name] === 'string' && notes[name]) state = 'degraded'
    byState[state].push(name)
  }
  for (const k of Object.keys(byState) as SourceState[]) byState[k].sort()
  return { byState, simulation }
}
