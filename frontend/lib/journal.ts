/**
 * The trade journal: what was planned, what was done, and what it returned.
 *
 * Each entry freezes the ticket record it came from, so the plan cannot be
 * edited after the fact to agree with the outcome. Everything measured here is
 * measured against that frozen plan:
 *
 *  - **R is measured from the fill, against the planned stop.** Risk at fill is
 *    `stopRisk()` from the sizing module — the same rounding, slippage and cost
 *    the ticket sized with, applied at the price actually paid. A fill at or
 *    through the planned stop has no defined risk, and R is not reported.
 *  - **Nothing is assumed.** Fees are an input: a missing fee is not a zero fee,
 *    so a closed trade without one has no realized figure. Exits must account
 *    for every unit filled.
 *  - **Violations the data shows are tagged automatically** (a blocked ticket
 *    taken, more units than planned, a stop moved further away, a second
 *    attempt at the same idea). Self-reported tags sit beside them. A trade is
 *    CLEAN only when it has neither and has been reviewed.
 *  - **Process and outcome are judged apart.** A clean loss is a rule-following
 *    trade; a winning violation does not validate the method.
 *  - **No rate below 30 trades.** Win rate and average R are withheld until 30
 *    closed trades carry a measured R, the floor the backend's track record
 *    uses. Counts and the sum of R are facts at any size and are shown.
 */
import type { Side } from './riskSize'
import { stopRisk } from './riskSize'
import { STOP_OUT_LOCK, TICKET_SCHEMA, type TicketRecord } from './tradeTicket'

export const JOURNAL_SCHEMA = 'quantflow.journal/v1' as const

/** Mirrors the backend's MIN_PUBLISHABLE_SAMPLE. */
export const MIN_SAMPLE = 30

export type EntryStatus = 'PLANNED' | 'TAKEN' | 'CLOSED' | 'PASSED'
export const ENTRY_STATUSES: readonly EntryStatus[] = ['PLANNED', 'TAKEN', 'CLOSED', 'PASSED']

export const SELF_TAGS = [
  'CHASE', 'FIRST_TOUCH', 'EARLY_BREAKEVEN', 'EXITED_EARLY', 'MOVED_TARGET', 'REVENGE', 'TILT', 'FATIGUE',
] as const
export type SelfTag = typeof SELF_TAGS[number]

export type AutoTag = 'TOOK_BLOCKED_TICKET' | 'OVERSIZED' | 'WIDENED_STOP' | 'SECOND_ATTEMPT'

export interface JournalSpec { tickSize: number; tickValue: number; unit: 'contract' | 'share' }
export interface Fill { price: number; units: number; at: string }
export interface Exit { price: number; units: number; at: string }

export interface JournalEntry {
  schema: typeof JOURNAL_SCHEMA
  id: string
  savedAt: string
  /** The ticket record as it stood when saved. Never edited. */
  ticket: TicketRecord
  spec: JournalSpec
  status: EntryStatus
  fill: Fill | null
  /** Where the stop actually was, if it was moved. Null: as planned. */
  actualStop: number | null
  exits: Exit[]
  /** Total commissions and fees actually paid, dollars. Null: not entered. */
  fees: number | null
  tags: SelfTag[]
  emotion: string
  review: { worked: string; failed: string; nextAction: string; afterScreenshot: string }
  reviewed: boolean
}

export interface Realized {
  pnl: number
  /** Dollars at risk at the fill, against the planned stop. Null when undefined. */
  riskAtFill: number | null
  r: number | null
}

export interface EntryEvaluation {
  autoTags: AutoTag[]
  realized: Realized | null
  /** Why a closed trade cannot be measured, or measured only in part. */
  problems: string[]
  outcome: 'WIN' | 'LOSS' | 'BREAKEVEN' | null
  process: 'CLEAN' | 'VIOLATION' | 'UNREVIEWED' | null
}

function finite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n)
}

function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** A NEUTRAL ticket is no idea at all, so there is nothing to journal. */
export function createEntry(ticket: TicketRecord, spec: JournalSpec, savedAt: string, id: string = newId()):
  { entry: JournalEntry } | { error: string } {
  if (ticket.state === 'NEUTRAL') return { error: 'A NEUTRAL ticket has no direction; there is nothing to journal yet.' }
  if (ticket.setupId === '') return { error: 'Give the idea a setup ID first: one attempt per idea is checked by it.' }
  if (!finite(spec.tickSize) || spec.tickSize <= 0 || !finite(spec.tickValue) || spec.tickValue <= 0) {
    return { error: 'The instrument has no usable tick size and value.' }
  }
  return {
    entry: {
      schema: JOURNAL_SCHEMA, id, savedAt, ticket, spec,
      status: 'PLANNED', fill: null, actualStop: null, exits: [], fees: null,
      tags: [], emotion: '',
      review: { worked: '', failed: '', nextAction: '', afterScreenshot: '' },
      reviewed: false,
    },
  }
}

export function setupKey(setupId: string): string {
  return setupId.trim().toUpperCase()
}

const wasTaken = (e: JournalEntry) => e.status === 'TAKEN' || e.status === 'CLOSED'

/** Earlier taken entries with this setup ID. */
export function priorAttempts(entries: readonly JournalEntry[], setupId: string): number {
  const k = setupKey(setupId)
  if (k === '') return 0
  return entries.filter((e) => wasTaken(e) && setupKey(e.ticket.setupId) === k).length
}

/** The America/New_York calendar date of an instant, or null if unreadable. */
export function etDate(iso: string): string | null {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(t)
}

/** When the trade was closed: its last exit. */
export function closedAt(e: JournalEntry): string | null {
  let best: string | null = null
  for (const x of e.exits) if (best === null || Date.parse(x.at) > Date.parse(best)) best = x.at
  return best
}

/**
 * P&L before fees, when the fill, the direction and exits covering every unit
 * are all recorded. Null otherwise.
 */
export function grossPnl(e: JournalEntry): number | null {
  const side = e.ticket.direction
  const fill = e.fill
  if (!fill || side === null || e.exits.length === 0) return null
  if (e.exits.reduce((a, x) => a + x.units, 0) !== fill.units) return null
  const sign = side === 'LONG' ? 1 : -1
  return e.exits.reduce((a, x) => a + ((x.price - fill.price) * sign / e.spec.tickSize) * e.spec.tickValue * x.units, 0)
}

export function realizedOf(e: JournalEntry): { realized: Realized | null; problems: string[] } {
  if (e.status !== 'CLOSED') return { realized: null, problems: [] }
  const problems: string[] = []
  const side = e.ticket.direction as Side | null
  if (!e.fill) problems.push('No fill is recorded.')
  if (e.exits.length === 0) problems.push('No exit is recorded.')
  if (e.fees === null) problems.push('Enter the fees actually paid (0 if none). A missing fee is not a zero fee.')
  if (side === null) problems.push('The ticket had no direction.')
  if (e.fill && e.exits.length) {
    const out = e.exits.reduce((a, x) => a + x.units, 0)
    if (out !== e.fill.units) problems.push(`Exits account for ${out} of ${e.fill.units} ${e.spec.unit}s filled.`)
  }
  const gross = grossPnl(e)
  if (problems.length || !e.fill || side === null || e.fees === null || gross === null) return { realized: null, problems }

  const sign = side === 'LONG' ? 1 : -1
  const fill = e.fill
  const pnl = gross - e.fees

  const { stop, slippageTicks, costPerUnit } = e.ticket.plan
  let riskAtFill: number | null = null
  if (stop === null || slippageTicks === null || costPerUnit === null) {
    problems.push('The ticket had no stop, slippage or cost, so R cannot be measured.')
  } else if ((stop - fill.price) * sign >= 0) {
    problems.push('Filled at or through the planned stop: risk at the fill is undefined, so R is not reported.')
  } else {
    riskAtFill = fill.units * stopRisk(e.spec.tickSize, e.spec.tickValue, fill.price, stop, slippageTicks, costPerUnit).lossPerUnit
  }
  return { realized: { pnl, riskAtFill, r: riskAtFill === null ? null : pnl / riskAtFill }, problems }
}

export function autoTagsOf(e: JournalEntry, all: readonly JournalEntry[]): AutoTag[] {
  const tags: AutoTag[] = []
  if (!wasTaken(e)) return tags
  if (e.ticket.state !== 'APPROVED_TRADE') tags.push('TOOK_BLOCKED_TICKET')
  const planned = e.ticket.plan.units
  if (e.fill && planned !== null && e.fill.units > planned) tags.push('OVERSIZED')
  const stop = e.ticket.plan.stop
  if (e.actualStop !== null && stop !== null && e.ticket.direction) {
    const further = e.ticket.direction === 'LONG' ? e.actualStop < stop : e.actualStop > stop
    if (further) tags.push('WIDENED_STOP')
  }
  const k = setupKey(e.ticket.setupId)
  const mine = e.fill ? Date.parse(e.fill.at) : Infinity
  const earlier = all.some((o) => o.id !== e.id && wasTaken(o) && setupKey(o.ticket.setupId) === k && (() => {
    const theirs = o.fill ? Date.parse(o.fill.at) : Infinity
    return theirs < mine || (theirs === mine && o.savedAt < e.savedAt)
  })())
  if (earlier) tags.push('SECOND_ATTEMPT')
  return tags
}

export function evaluateEntry(e: JournalEntry, all: readonly JournalEntry[]): EntryEvaluation {
  const autoTags = autoTagsOf(e, all)
  const { realized, problems } = realizedOf(e)
  const outcome = realized === null ? null : realized.pnl > 0 ? 'WIN' : realized.pnl < 0 ? 'LOSS' : 'BREAKEVEN'
  let process: EntryEvaluation['process'] = null
  if (e.status === 'CLOSED') {
    process = autoTags.length || e.tags.length ? 'VIOLATION' : e.reviewed ? 'CLEAN' : 'UNREVIEWED'
  }
  return { autoTags, realized, problems, outcome, process }
}

/**
 * Closed losing trades whose last exit fell on this ET date. A trade whose
 * fees are not entered yet still counts when it lost before fees: fees can
 * only make a loss larger, and a lock that waits for paperwork is no lock.
 */
export function stopOutsOn(entries: readonly JournalEntry[], dateEt: string): number {
  return entries.filter((e) => {
    if (e.status !== 'CLOSED') return false
    const at = closedAt(e)
    if (!at || etDate(at) !== dateEt) return false
    const gross = grossPnl(e)
    if (gross === null) return false
    if (gross < 0) return true
    return e.fees !== null && gross - e.fees < 0
  }).length
}

export interface Bucket { n: number; totalR: number }

export interface JournalStats {
  saved: number
  taken: number
  closed: number
  passed: number
  /** Closed trades with a measured R: the sample every rate is over. */
  measured: number
  wins: number
  losses: number
  breakeven: number
  totalR: number
  /** Null until `measured` reaches MIN_SAMPLE. */
  rates: { winRate: number; avgR: number } | null
  byProcess: { clean: Bucket; violation: Bucket; unreviewed: Bucket }
  tagCounts: Partial<Record<AutoTag | SelfTag, number>>
}

export function journalStats(entries: readonly JournalEntry[]): JournalStats {
  const s: JournalStats = {
    saved: entries.length, taken: 0, closed: 0, passed: 0, measured: 0,
    wins: 0, losses: 0, breakeven: 0, totalR: 0, rates: null,
    byProcess: { clean: { n: 0, totalR: 0 }, violation: { n: 0, totalR: 0 }, unreviewed: { n: 0, totalR: 0 } },
    tagCounts: {},
  }
  for (const e of entries) {
    if (e.status === 'PASSED') s.passed++
    if (!wasTaken(e)) continue
    s.taken++
    const ev = evaluateEntry(e, entries)
    for (const t of [...ev.autoTags, ...e.tags]) s.tagCounts[t] = (s.tagCounts[t] ?? 0) + 1
    if (e.status !== 'CLOSED') continue
    s.closed++
    if (ev.realized === null || ev.realized.r === null) continue
    s.measured++
    s.totalR += ev.realized.r
    if (ev.outcome === 'WIN') s.wins++
    else if (ev.outcome === 'LOSS') s.losses++
    else s.breakeven++
    const b = ev.process === 'CLEAN' ? s.byProcess.clean : ev.process === 'VIOLATION' ? s.byProcess.violation : s.byProcess.unreviewed
    b.n++
    b.totalR += ev.realized.r
  }
  if (s.measured >= MIN_SAMPLE) s.rates = { winRate: s.wins / s.measured, avgR: s.totalR / s.measured }
  return s
}

/** Shape check for an entry read back from storage or an import. */
export function isEntry(v: unknown): v is JournalEntry {
  if (!v || typeof v !== 'object') return false
  const e = v as Partial<JournalEntry>
  return e.schema === JOURNAL_SCHEMA
    && typeof e.id === 'string' && e.id !== ''
    && typeof e.savedAt === 'string'
    && !!e.ticket && (e.ticket as { schema?: unknown }).schema === TICKET_SCHEMA
    && !!e.spec && finite(e.spec.tickSize) && e.spec.tickSize > 0 && finite(e.spec.tickValue) && e.spec.tickValue > 0
    && ENTRY_STATUSES.includes(e.status as EntryStatus)
    && Array.isArray(e.exits) && e.exits.every((x) => finite(x?.price) && finite(x?.units) && typeof x?.at === 'string')
    && (e.fill === null || (finite(e.fill?.price) && finite(e.fill?.units) && typeof e.fill?.at === 'string'))
    && (e.fees === null || finite(e.fees))
    && (e.actualStop === null || finite(e.actualStop))
    && Array.isArray(e.tags) && e.tags.every((t) => (SELF_TAGS as readonly string[]).includes(t))
    && typeof e.reviewed === 'boolean'
    && !!e.review && typeof e.review.worked === 'string'
}

export { STOP_OUT_LOCK }
