/**
 * One replay idea as a timeline: each transition with the bar it cites, when
 * that bar closed, when the transition became knowable, and how long after the
 * idea's first transition it came.
 *
 * Nothing here re-decides anything the engine decided. Two checks are made
 * against the engine's own fields, and a failure is reported on the row, never
 * repaired:
 *  - `knownAt` must not precede the close of the bar it cites. A transition
 *    knowable before its bar closed would be look-ahead (the engine works on
 *    closed bars only), so the row is flagged `BEFORE_BAR_CLOSE`.
 *  - transitions must arrive in non-decreasing `knownAt` order. Out-of-order
 *    rows are flagged `OUT_OF_ORDER` and left where the engine put them: sorting
 *    them would hide the defect.
 * A bar id that cannot be read (`SYMBOL:<n>m:<openMs>`) gives null bar times and
 * `BAR_UNREADABLE`; no close is guessed for it.
 */
export interface TimelineInput {
  state: string
  knownAt: number
  bar: string
  reasons: { code: string; detail: string }[]
  events?: string[]
}

export type TimelineFlag = 'BEFORE_BAR_CLOSE' | 'OUT_OF_ORDER' | 'BAR_UNREADABLE' | 'KNOWN_AT_UNREADABLE'

export interface TimelineRow {
  n: number
  state: string
  knownAt: number | null
  barId: string
  barSymbol: string | null
  barOpen: number | null
  barClose: number | null
  /** Minutes since the first readable transition; null when unreadable. */
  sinceStartMin: number | null
  reasons: { code: string; detail: string }[]
  events: string[]
  flags: TimelineFlag[]
}

const BAR_ID = /^([A-Z0-9.^/_-]+):(\d+)m:(\d+)$/

export function parseBarId(id: string): { symbol: string; open: number; close: number } | null {
  const m = BAR_ID.exec(id)
  if (!m) return null
  const minutes = Number(m[2])
  const open = Number(m[3])
  if (!(minutes > 0) || !Number.isSafeInteger(open)) return null
  return { symbol: m[1], open, close: open + minutes * 60_000 }
}

export function ideaTimeline(history: readonly TimelineInput[]): TimelineRow[] {
  const first = history.find((t) => Number.isFinite(t.knownAt))?.knownAt ?? null
  let last = -Infinity
  return history.map((t, n) => {
    const flags: TimelineFlag[] = []
    const known = Number.isFinite(t.knownAt) ? t.knownAt : null
    if (known === null) flags.push('KNOWN_AT_UNREADABLE')
    const bar = typeof t.bar === 'string' ? parseBarId(t.bar) : null
    if (bar === null) flags.push('BAR_UNREADABLE')
    if (known !== null && bar !== null && known < bar.close) flags.push('BEFORE_BAR_CLOSE')
    if (known !== null) {
      if (known < last) flags.push('OUT_OF_ORDER')
      else last = known
    }
    return {
      n,
      state: t.state,
      knownAt: known,
      barId: String(t.bar),
      barSymbol: bar?.symbol ?? null,
      barOpen: bar?.open ?? null,
      barClose: bar?.close ?? null,
      sinceStartMin: known !== null && first !== null ? (known - first) / 60_000 : null,
      reasons: t.reasons ?? [],
      events: t.events ?? [],
      flags,
    }
  })
}
