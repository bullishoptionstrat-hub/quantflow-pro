/**
 * What the structure chart may draw at a replay cursor, computed from the
 * structure report alone. Pure and clock-free.
 *
 * Rules:
 *  - Only bars that have closed at or before the cursor are drawn. The report
 *    publishes closed bars only, so there is never a forming bar.
 *  - An event is drawn only once the cursor reaches its `knownAt`, and only
 *    from the bar that closed at `knownAt` onward. A swing is marked at the bar
 *    that confirmed it, not back-dated to its pivot, so the chart never shows
 *    a swing at a moment it could not yet have been known.
 *  - An FVG box spans from its formation's `knownAt` to the `knownAt` of the
 *    first event that ended it (filled, inverted, expired), or to the cursor.
 *  - A bar whose prices do not form a candle (non-finite, high below the
 *    body, low above it) is not drawn and is counted, never repaired. An
 *    event whose `knownAt` matches no drawn bar is not drawn and is counted.
 *  - A price the event did not carry is not drawn; nothing is defaulted.
 */

export interface ChartBar { tOpen: number; closedAt: number; o: number; h: number; l: number; c: number }
export interface ChartEvent { id: string; kind: string; knownAt: number; [k: string]: unknown }

export type Overlay =
  | { type: 'MARK'; id: string; kind: string; knownAt: number; x: number; price: number; label: string }
  | { type: 'LEVEL'; id: string; kind: string; knownAt: number; x: number; price: number; label: string }
  | { type: 'BOX'; id: string; kind: string; knownAt: number; x: number; xEnd: number; top: number; bottom: number; label: string; open: boolean }

export interface ChartModel {
  bars: ChartBar[]
  overlays: Overlay[]
  unreadableBars: number
  unplacedEvents: number
  cursor: number | null
}

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function isCandle(b: unknown): b is ChartBar {
  if (typeof b !== 'object' || b === null) return false
  const r = b as Record<string, unknown>
  if (![r.tOpen, r.closedAt, r.o, r.h, r.l, r.c].every(fin)) return false
  const x = r as unknown as ChartBar
  return x.closedAt > x.tOpen && x.h >= Math.max(x.o, x.c) && x.l <= Math.min(x.o, x.c)
}

const priceOf = (v: unknown): number | null => {
  if (fin(v)) return v
  if (typeof v === 'object' && v !== null && fin((v as Record<string, unknown>).price)) return (v as Record<string, number>).price
  return null
}

const FVG_END = new Set(['FVG_FILLED', 'FVG_INVERTED', 'FVG_EXPIRED'])

/** `cursor` is a close time; null means the last bar. */
export function chartModel(rawBars: unknown, events: ChartEvent[], cursor: number | null): ChartModel {
  const all = Array.isArray(rawBars) ? rawBars : []
  const good = all.filter(isCandle)
  const unreadableBars = all.length - good.length
  const last = good.length > 0 ? good[good.length - 1]!.closedAt : null
  const at = cursor ?? last
  const bars = at === null ? [] : good.filter((b) => b.closedAt <= at)
  const index = new Map(bars.map((b, i) => [b.closedAt, i]))

  const visible = at === null ? [] : events.filter((e) => fin(e.knownAt) && e.knownAt <= at)
  const ends = new Map<string, number>()
  for (const e of visible) if (FVG_END.has(e.kind) && typeof e.fvgId === 'string') {
    const prev = ends.get(e.fvgId)
    if (prev === undefined || e.knownAt < prev) ends.set(e.fvgId, e.knownAt)
  }

  const overlays: Overlay[] = []
  let unplaced = 0
  for (const e of visible) {
    const x = index.get(e.knownAt)
    const place = (o: Overlay | null) => { if (o === null) return; if (x === undefined) { unplaced++; return } overlays.push(o) }
    if (e.kind === 'SWING_HIGH' || e.kind === 'SWING_LOW') {
      const p = priceOf(e.price)
      if (p !== null && x !== undefined) overlays.push({ type: 'MARK', id: e.id, kind: e.kind, knownAt: e.knownAt, x, price: p, label: e.kind === 'SWING_HIGH' ? 'SH' : 'SL' })
      else if (p !== null) unplaced++
    } else if (e.kind === 'FVG_FORMED') {
      if (!fin(e.top) || !fin(e.bottom) || typeof e.fvgId !== 'string') continue
      const endAt = ends.get(e.fvgId)
      const xEnd = endAt !== undefined ? index.get(endAt) : bars.length - 1
      if (x === undefined || xEnd === undefined) { unplaced++; continue }
      place({ type: 'BOX', id: e.id, kind: e.kind, knownAt: e.knownAt, x, xEnd, top: e.top, bottom: e.bottom, open: endAt === undefined, label: e.direction === 'BULLISH' ? 'FVG+' : 'FVG−' })
    } else if (e.kind === 'BOS' || e.kind === 'CHOCH') {
      const p = priceOf(e.broken)
      if (p !== null) place({ type: 'MARK', id: e.id, kind: e.kind, knownAt: e.knownAt, x: x ?? -1, price: p, label: e.kind })
    } else if (e.kind === 'SWEEP_RECLAIM') {
      const p = priceOf(e.extreme)
      if (p !== null) place({ type: 'MARK', id: e.id, kind: e.kind, knownAt: e.knownAt, x: x ?? -1, price: p, label: 'SWP' })
    } else if (e.kind === 'SESSION_LEVEL') {
      const p = priceOf(e.price)
      if (p !== null) place({ type: 'LEVEL', id: e.id, kind: e.kind, knownAt: e.knownAt, x: x ?? -1, price: p, label: typeof e.name === 'string' ? e.name : 'LEVEL' })
    }
  }
  return { bars, overlays, unreadableBars, unplacedEvents: unplaced, cursor: at }
}
