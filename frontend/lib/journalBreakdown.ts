/**
 * Journal analytics by one dimension: model, instrument, session profile,
 * process grade or tag.
 *
 * The sample is the one `journalStats` uses: CLOSED entries with a measured R.
 * Every bucket reports its counts and summed R; a win rate and average R are
 * published for a bucket only at MIN_SAMPLE measured trades, the same floor as
 * the whole-journal figure. Splitting a journal makes every slice smaller, so
 * most buckets will show counts only — which is the honest answer.
 *
 * By tag, one trade can sit in several buckets (and in none), so tag buckets do
 * not sum to the total; `overlapping` says so. A missing model or profile is
 * its own bucket (`NONE`), never folded into another.
 */
import { MIN_SAMPLE, evaluateEntry, type JournalEntry } from './journal'

export type BreakdownDimension = 'model' | 'symbol' | 'sessionProfile' | 'process' | 'tag'
export const BREAKDOWN_DIMENSIONS: readonly BreakdownDimension[] = ['model', 'symbol', 'sessionProfile', 'process', 'tag']

export interface BreakdownBucket {
  key: string
  measured: number
  wins: number
  losses: number
  breakeven: number
  totalR: number
  /** Null below MIN_SAMPLE measured trades. */
  rates: { winRate: number; avgR: number } | null
}

export interface Breakdown {
  dimension: BreakdownDimension
  minSample: number
  measured: number
  overlapping: boolean
  buckets: BreakdownBucket[]
}

function keysOf(e: JournalEntry, dim: BreakdownDimension, ev: ReturnType<typeof evaluateEntry>): string[] {
  const label = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : 'NONE')
  switch (dim) {
    case 'model': return [label(e.ticket.model)]
    case 'symbol': return [label(e.ticket.symbol)]
    case 'sessionProfile': return [label(e.ticket.sessionProfile)]
    case 'process': return [ev.process ?? 'NONE']
    case 'tag': {
      const t = [...ev.autoTags, ...e.tags]
      return t.length ? Array.from(new Set(t)) : ['UNTAGGED']
    }
  }
}

export function journalBreakdown(entries: readonly JournalEntry[], dimension: BreakdownDimension): Breakdown {
  const map = new Map<string, BreakdownBucket>()
  let measured = 0
  for (const e of entries) {
    if (e.status !== 'CLOSED') continue
    const ev = evaluateEntry(e, entries)
    const r = ev.realized?.r
    if (r === null || r === undefined || !Number.isFinite(r)) continue
    measured++
    for (const key of keysOf(e, dimension, ev)) {
      let b = map.get(key)
      if (!b) { b = { key, measured: 0, wins: 0, losses: 0, breakeven: 0, totalR: 0, rates: null }; map.set(key, b) }
      b.measured++
      b.totalR += r
      if (ev.outcome === 'WIN') b.wins++
      else if (ev.outcome === 'LOSS') b.losses++
      else b.breakeven++
    }
  }
  const buckets = Array.from(map.values())
  for (const b of buckets) if (b.measured >= MIN_SAMPLE) b.rates = { winRate: b.wins / b.measured, avgR: b.totalR / b.measured }
  buckets.sort((a, b) => b.measured - a.measured || a.key.localeCompare(b.key))
  return { dimension, minSample: MIN_SAMPLE, measured, overlapping: dimension === 'tag', buckets }
}
