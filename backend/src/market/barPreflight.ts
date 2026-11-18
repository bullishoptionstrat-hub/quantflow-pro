/**
 * Bar-import preflight: what a CSV holds before anything is replayed over it.
 *
 * It runs `importBarsCsv` — the parser the replay uses, not a second one — and
 * summarises its own output: refused files, rejected rows grouped by reason,
 * duplicates and out-of-order rows, gaps, and how the kept bars line up with
 * the market calendar's published regular session, per ET date.
 *
 * Nothing here repairs or fills anything. A day the calendar cannot answer for
 * (past `COVERAGE`) is `UNKNOWN` and its RTH coverage is not computed, because
 * an assumed 09:30-16:00 is what the calendar exists to replace. Bars on a
 * weekend or published holiday are counted and named, not dropped.
 */
import { importBarsCsv, TimestampMarks, RejectedRow } from './barImport';
import { sessionOn } from '../flow-engine/calendar';
import { addDays, instantEt, marketDateOf, minutesEt } from './civil';

const MINUTE = 60_000;

export const REJECT_CODES = [
  'CELL_COUNT', 'TIMESTAMP', 'NOT_DECIMAL', 'OFF_MINUTE', 'BAR_SHAPE', 'DUPLICATE', 'OUT_OF_ORDER', 'OTHER',
] as const;
export type RejectCode = typeof REJECT_CODES[number];

/** The category of one reason string `importBarsCsv` wrote. */
export function rejectCode(reason: string): RejectCode {
  if (/^has \d+ cells, header has \d+$/.test(reason)) return 'CELL_COUNT';
  if (/^timestamp /.test(reason)) return reason === 'timestamp is not on a minute boundary' ? 'OFF_MINUTE' : 'TIMESTAMP';
  if (/^(open|high|low|close|volume) .* is not a decimal number$/.test(reason)) return 'NOT_DECIMAL';
  if (/^duplicates the minute /.test(reason)) return 'DUPLICATE';
  if (/^is out of order: /.test(reason)) return 'OUT_OF_ORDER';
  if (/^(o|h|l|c) .*(is not a positive price|is not a finite number)$|^h .* is below max\(o, c\)|^l .* is above min\(o, c\)|^v must be/.test(reason)) return 'BAR_SHAPE';
  return 'OTHER';
}

export interface RejectGroup { code: RejectCode; rows: number; firstLines: number[]; example: string }

export interface DayAlignment {
  date: string
  /** The calendar's answer for the date. */
  session: 'REGULAR' | 'EARLY_CLOSE' | 'HOLIDAY' | 'WEEKEND' | 'UNKNOWN'
  bars: number
  /** Bars opening inside the published regular session. Null when the calendar cannot say. */
  rthBars: number | null
  /** Minutes in the published regular session. Null when closed or unknown. */
  rthMinutes: number | null
  /** rthBars / rthMinutes, or null. */
  rthCoverage: number | null
  outsideRthBars: number | null
}

export interface SymbolPreflight {
  symbol: string
  status: 'OK' | 'REFUSED'
  refused: string[]
  lines: number
  keptBars: number
  coverage: { firstTOpen: number; lastClosedAt: number } | null
  rejectedRows: number
  rejectedByCode: RejectGroup[]
  duplicates: number
  outOfOrder: number
  gaps: { count: number; missingMinutes: number; insideRthMinutes: number | null; largest: { afterTOpen: number; beforeTOpen: number; missingMinutes: number } | null }
  days: DayAlignment[]
  /** Short sentences a reader should see before trusting a replay on this file. */
  warnings: string[]
}

function groupRejected(rows: RejectedRow[]): RejectGroup[] {
  const m = new Map<RejectCode, RejectGroup>()
  for (const r of rows) {
    const seen = new Set<RejectCode>()
    for (const reason of r.reasons) {
      const code = rejectCode(reason)
      if (seen.has(code)) continue
      seen.add(code)
      const g = m.get(code) ?? { code, rows: 0, firstLines: [], example: reason }
      g.rows++
      if (g.firstLines.length < 5) g.firstLines.push(r.line)
      m.set(code, g)
    }
  }
  return REJECT_CODES.filter((c) => m.has(c)).map((c) => m.get(c)!)
}

/** Published regular-session bounds for a date, in ET minutes, or null. */
function rthBounds(date: string): { open: number; close: number } | null {
  const s = sessionOn(date)
  if ((s.kind !== 'REGULAR' && s.kind !== 'EARLY_CLOSE') || s.openHour === null || s.openMinute === null
    || s.closeHour === null || s.closeMinute === null) return null
  return { open: s.openHour * 60 + s.openMinute, close: s.closeHour * 60 + s.closeMinute }
}

/**
 * Minutes of the published regular session in [fromMs, toMs), walked a date
 * at a time (a gap can be months long). Null when any date in the span is one
 * the calendar cannot answer for.
 */
export function rthMinutesBetween(fromMs: number, toMs: number): number | null {
  if (!(toMs > fromMs)) return 0
  const first = marketDateOf(fromMs), last = marketDateOf(toMs - 1)
  if (first === null || last === null) return null
  let total = 0
  for (let d: string | null = first; d !== null && d <= last; d = addDays(d, 1)) {
    if (sessionOn(d).kind === 'UNKNOWN') return null
    const r = rthBounds(d)
    if (!r) continue
    const open = instantEt(d, Math.floor(r.open / 60), r.open % 60)
    const close = instantEt(d, Math.floor(r.close / 60), r.close % 60)
    if (open === null || close === null) return null
    const lo = Math.max(open, fromMs), hi = Math.min(close, toMs)
    if (hi > lo) total += Math.round((hi - lo) / MINUTE)
  }
  return total
}

export function preflightBars(symbol: string, text: string, timestampMarks: TimestampMarks): SymbolPreflight {
  const lines = text.split(/\r?\n/).filter((l, i, a) => i < a.length - 1 || l.trim() !== '').length
  const res = importBarsCsv(text, { symbol, timestampMarks, source: 'preflight' })
  const empty = { count: 0, missingMinutes: 0, insideRthMinutes: null, largest: null }
  if (res.status === 'REFUSED') {
    return {
      symbol, status: 'REFUSED', refused: res.reasons, lines, keptBars: 0, coverage: null,
      rejectedRows: 0, rejectedByCode: [], duplicates: 0, outOfOrder: 0, gaps: empty, days: [],
      warnings: ['The file was refused; nothing in it can be replayed.'],
    }
  }
  const groups = groupRejected(res.rejected)
  const count = (c: RejectCode) => groups.find((g) => g.code === c)?.rows ?? 0

  // Per ET date: which bars sit inside the published regular session.
  const byDate = new Map<string, number[]>()
  for (const b of res.bars) {
    const d = marketDateOf(b.tOpen) ?? 'UNREADABLE'
    const arr = byDate.get(d) ?? []
    arr.push(b.tOpen)
    byDate.set(d, arr)
  }
  const days: DayAlignment[] = [...byDate.keys()].sort().map((date) => {
    const opens = byDate.get(date)!
    const kind = date === 'UNREADABLE' ? 'UNKNOWN' : sessionOn(date).kind
    const rth = date === 'UNREADABLE' ? null : rthBounds(date)
    if (kind === 'UNKNOWN') return { date, session: kind, bars: opens.length, rthBars: null, rthMinutes: null, rthCoverage: null, outsideRthBars: null }
    if (!rth) return { date, session: kind, bars: opens.length, rthBars: 0, rthMinutes: null, rthCoverage: null, outsideRthBars: opens.length }
    const inside = opens.filter((t) => { const m = minutesEt(t); return m !== null && m >= rth.open && m < rth.close }).length
    const minutes = rth.close - rth.open
    return { date, session: kind, bars: opens.length, rthBars: inside, rthMinutes: minutes, rthCoverage: inside / minutes, outsideRthBars: opens.length - inside }
  })

  // Gap minutes that fall inside a published regular session. Null when any
  // gapped date is one the calendar cannot answer for.
  let insideRth: number | null = 0
  let largest: SymbolPreflight['gaps']['largest'] = null
  let missing = 0
  for (const g of res.gaps) {
    missing += g.missingMinutes
    if (!largest || g.missingMinutes > largest.missingMinutes) largest = g
    if (insideRth === null) continue
    const inside = rthMinutesBetween(g.afterTOpen + MINUTE, g.beforeTOpen)
    insideRth = inside === null ? null : insideRth + inside
  }

  const warnings: string[] = []
  if (res.bars.length === 0) warnings.push('No bar was kept.')
  if (res.rejected.length > 0) warnings.push(`${res.rejected.length} row${res.rejected.length === 1 ? ' was' : 's were'} rejected and will not be replayed.`)
  const closed = days.filter((d) => d.session === 'HOLIDAY' || d.session === 'WEEKEND')
  if (closed.length) warnings.push(`Bars on ${closed.map((d) => `${d.date} (${d.session})`).join(', ')}, when the calendar says the regular session was closed.`)
  const unknown = days.filter((d) => d.session === 'UNKNOWN')
  if (unknown.length) warnings.push(`The calendar cannot answer for ${unknown.map((d) => d.date).join(', ')}; RTH coverage there is not computed.`)
  if (insideRth !== null && insideRth > 0) warnings.push(`${insideRth} minute${insideRth === 1 ? '' : 's'} of the published regular session ${insideRth === 1 ? 'is' : 'are'} missing.`)
  const thin = days.filter((d) => d.rthCoverage !== null && d.rthCoverage < 0.95)
  if (thin.length) warnings.push(`Under 95% of the regular session on ${thin.map((d) => d.date).join(', ')}.`)

  return {
    symbol, status: 'OK', refused: [], lines, keptBars: res.bars.length,
    coverage: res.coverage ? { firstTOpen: res.coverage.firstTOpen, lastClosedAt: res.coverage.lastClosedAt } : null,
    rejectedRows: res.rejected.length, rejectedByCode: groups,
    duplicates: count('DUPLICATE'), outOfOrder: count('OUT_OF_ORDER'),
    gaps: { count: res.gaps.length, missingMinutes: missing, insideRthMinutes: insideRth, largest },
    days, warnings,
  }
}
