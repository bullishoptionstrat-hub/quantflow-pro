/**
 * The daily plan: the God's Plan pre-session map, one per ET trading date.
 *
 * Everything in a plan is the trader's own input. Nothing is pre-filled and no
 * field has a default that could be read as a decision: the bias is NEUTRAL
 * (null) until a direction is chosen, the loss limit and the maximum attempts
 * are empty until written, and an empty one is a checklist item that names
 * itself. The only numbers this module computes are arithmetic on what the
 * trader wrote (the dealing range's EQ) and on what the journal recorded (the
 * day's realized loss and attempts).
 *
 * The rules, each closing a way a plan stops being a plan:
 *
 *  - **The date is the backend's.** `planDateFrom` reads `session.date` from
 *    `/api/health` and nothing else. With no answer the date is unknown and no
 *    plan can be created or edited — the browser does not pick a trading date
 *    off its own clock. (`etDate` in the journal converts an instant the
 *    trader recorded; it never decides which day is today.)
 *  - **One plan per date, and plans are never replaced.** A second plan for a
 *    date is refused, and a past date's plan is a record, not a draft.
 *  - **A plan freezes at the first taken trade.** Until a journal entry with a
 *    fill on the plan's date is TAKEN, saving replaces the plan. After it, the
 *    plan as written is kept untouched in `body` and every later save is an
 *    amendment with a timestamp, so a plan cannot be rewritten after the fact
 *    to agree with the trade. If the journal cannot be read, the plan is
 *    treated as frozen: an edit it cannot place before or after a trade is
 *    recorded rather than allowed to overwrite.
 *  - **Amendments can only tighten what the ticket checks.** The ticket reads
 *    the strictest loss limit and maximum attempts across the plan and every
 *    amendment, and every stand-aside window any of them declares. The
 *    checklist is read from `body` — the plan as written before the first
 *    trade — so an amendment cannot complete a plan after the fact.
 *  - **The checklist is derived, never ticked.** Each item is complete only
 *    when the fields behind it are filled. "Events reviewed" is a written
 *    answer (where the calendar was checked), not a box.
 *
 * The day's realized loss, measured for the written limit:
 *
 *    realizedLoss = max(0, −Σ P&L of trades whose last exit fell on the date)
 *
 * where a trade with fees entered counts its net P&L; a losing trade with no
 * fees yet counts its gross loss (a lower bound — fees only make it larger, the
 * same rule as the stop-out lock); and a winning trade with no fees yet is left
 * out, since its net is unknown and counting its gross could offset a real loss
 * with money the fees took. A trade whose exits do not cover its fill is not
 * measurable and is counted apart. An attempt is a journal entry taken on the
 * date (its fill's ET date), closed or still open.
 */
import {
  closedAt, etDate, evaluateEntry, grossPnl, stopOutsOn, type JournalEntry,
} from './journal'
import {
  SESSION_PROFILES, minutesOf, windowContains,
  type PlanContext, type PlanEventWindow, type SessionProfileId,
} from './tradeTicket'

export const PLAN_SCHEMA = 'quantflow.plan/v1' as const

export const LEVEL_TYPES = [
  'PDH', 'PDL', 'PWH', 'PWL', 'ONH', 'ONL', 'ASIA_H', 'ASIA_L', 'LONDON_H', 'LONDON_L',
  'EQH', 'EQL', 'FVG', 'IFVG', 'OB', 'BREAKER', 'VWAP', 'GEX_REF', 'OTHER',
] as const
export type LevelType = typeof LEVEL_TYPES[number]

export const LEVEL_STATUSES = ['FRESH', 'MITIGATED', 'INVALIDATED'] as const
export type LevelStatus = typeof LEVEL_STATUSES[number]

export const LIQUIDITY = ['INTERNAL', 'EXTERNAL'] as const
export type Liquidity = typeof LIQUIDITY[number]

export type Bias = 'BULLISH' | 'BEARISH'

export interface KeyLevel {
  label: string
  price: number | null
  type: LevelType | null
  liquidity: Liquidity | null
  status: LevelStatus | null
}

export interface Scenario {
  if: string
  then: string
  /** What invalidates it, or (for no-trade) what cancels standing aside. */
  invalidation: string
  opposingLiquidity: string
  targets: string
}

export const SCENARIO_KEYS = ['primary', 'alternate', 'noTrade'] as const
export type ScenarioKey = typeof SCENARIO_KEYS[number]
export const SCENARIO_LABELS: Record<ScenarioKey, string> = { primary: 'Primary', alternate: 'Alternate', noTrade: 'No-trade' }

export interface PlanEvent {
  /** `HH:MM`, ET. */
  time: string
  name: string
  /** Minutes to stand aside before and after. The trader's policy; null: not written. */
  beforeMin: number | null
  afterMin: number | null
}

export interface PlanBody {
  instruments: string[]
  /** Null is NEUTRAL: no bias chosen. */
  htfBias: Bias | null
  sessionProfile: SessionProfileId | null
  levels: KeyLevel[]
  range: { high: number | null; low: number | null }
  scenarios: Record<ScenarioKey, Scenario>
  events: PlanEvent[]
  /** Where the economic calendar was checked. Written even when nothing is scheduled. */
  eventsChecked: string
  /** The day's written dollar loss limit. */
  lossLimit: number | null
  maxAttempts: number | null
}

export interface Amendment {
  at: string
  body: PlanBody
  changed: (keyof PlanBody)[]
}

export interface DailyPlan {
  schema: typeof PLAN_SCHEMA
  /** The ET trading date, from the backend. */
  date: string
  createdAt: string
  updatedAt: string
  /** The plan as written before the date's first taken trade. Never edited after it. */
  body: PlanBody
  /**
   * Whether the plan was created after a trade on its date had already been
   * taken. Null: the journal could not be read at creation, so it is unknown,
   * and the plan is treated as frozen.
   */
  createdAfterFirstTrade: boolean | null
  amendments: Amendment[]
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const filled = (s: string) => s.trim() !== ''

export function emptyScenario(): Scenario {
  return { if: '', then: '', invalidation: '', opposingLiquidity: '', targets: '' }
}

export function emptyBody(): PlanBody {
  return {
    instruments: [], htfBias: null, sessionProfile: null, levels: [],
    range: { high: null, low: null },
    scenarios: { primary: emptyScenario(), alternate: emptyScenario(), noTrade: emptyScenario() },
    events: [], eventsChecked: '', lossLimit: null, maxAttempts: null,
  }
}

// ─── The date ──────────────────────────────────────────────────────────────

/** `YYYY-MM-DD` that is a real calendar day. */
export function isPlanDate(s: unknown): s is string {
  if (typeof s !== 'string') return false
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return false
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.toISOString().slice(0, 10) === s
}

/**
 * Today's ET trading date, from the backend's session payload and nowhere
 * else. Null when the backend has not answered or sent no readable date.
 */
export function planDateFrom(session: { date?: unknown } | null | undefined): string | null {
  const d = session?.date
  return isPlanDate(d) ? d : null
}

// ─── The dealing range ─────────────────────────────────────────────────────

export interface DealingRange {
  high: number
  low: number
  /** Equilibrium: the midpoint, (high + low) / 2. */
  eq: number
}

/** The range and its EQ, or null when either bound is missing or high ≤ low. */
export function dealingRange(high: number | null, low: number | null): DealingRange | null {
  if (!finite(high) || !finite(low) || high <= low) return null
  return { high, low, eq: (high + low) / 2 }
}

export type Zone = 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM' | 'ABOVE_RANGE' | 'BELOW_RANGE'

/** Where a price sits in the range: above EQ is premium, below is discount. */
export function zoneOf(price: number, r: DealingRange): Zone {
  if (price > r.high) return 'ABOVE_RANGE'
  if (price < r.low) return 'BELOW_RANGE'
  if (price === r.eq) return 'EQUILIBRIUM'
  return price > r.eq ? 'PREMIUM' : 'DISCOUNT'
}

// ─── Events ────────────────────────────────────────────────────────────────

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

/**
 * The stand-aside window around an event, on the plan's date only: start
 * inclusive, end exclusive, clipped to the day. Null when the time is not
 * `HH:MM` or either stand-aside figure is not written.
 */
export function eventWindow(e: PlanEvent): PlanEventWindow | null {
  if (!HHMM.test(e.time) || !finite(e.beforeMin) || !finite(e.afterMin) || e.beforeMin < 0 || e.afterMin < 0) return null
  const t = minutesOf(e.time)
  return { name: e.name.trim() || 'Event', time: e.time, start: Math.max(0, t - e.beforeMin), end: Math.min(24 * 60, t + e.afterMin) }
}

/** The plan's body, then each amendment's, oldest first. */
export function bodiesOf(plan: DailyPlan): PlanBody[] {
  return [plan.body, ...plan.amendments.map((a) => a.body)]
}

/** What the plan says now: the last amendment, or the plan as written. */
export function effectiveBody(plan: DailyPlan): PlanBody {
  return plan.amendments.length ? plan.amendments[plan.amendments.length - 1]!.body : plan.body
}

/** Every stand-aside window the plan or any amendment declares. */
export function planWindows(plan: DailyPlan): PlanEventWindow[] {
  const seen = new Set<string>()
  const out: PlanEventWindow[] = []
  for (const b of bodiesOf(plan)) {
    for (const e of b.events) {
      const w = eventWindow(e)
      if (!w || w.end <= w.start) continue
      const k = `${w.name}|${w.start}|${w.end}`
      if (seen.has(k)) continue
      seen.add(k)
      out.push(w)
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end)
}

/** The strictest loss limit and maximum attempts across the plan and its amendments. */
export function strictestLimits(plan: DailyPlan): { lossLimit: number | null; maxAttempts: number | null } {
  let lossLimit: number | null = null
  let maxAttempts: number | null = null
  for (const b of bodiesOf(plan)) {
    if (validLossLimit(b.lossLimit) && (lossLimit === null || b.lossLimit < lossLimit)) lossLimit = b.lossLimit
    if (validMaxAttempts(b.maxAttempts) && (maxAttempts === null || b.maxAttempts < maxAttempts)) maxAttempts = b.maxAttempts
  }
  return { lossLimit, maxAttempts }
}

/**
 * Where `now` stands against the windows: the ones it is inside, and the next
 * one to start. Time arithmetic on the backend's ET minutes only.
 */
export function eventClock(windows: readonly PlanEventWindow[], now: number): {
  inside: PlanEventWindow[]
  next: { window: PlanEventWindow; minutesToStart: number } | null
} {
  const inside = windows.filter((w) => windowContains(w, now))
  const upcoming = windows.filter((w) => w.start > now).sort((a, b) => a.start - b.start)
  const n = upcoming[0]
  return { inside, next: n ? { window: n, minutesToStart: n.start - now } : null }
}

// ─── The checklist ─────────────────────────────────────────────────────────

export type ChecklistId = 'INSTRUMENTS' | 'SESSION' | 'LEVELS' | 'SCENARIOS' | 'RISK_LIMITS' | 'EVENTS'

export interface ChecklistItem {
  id: ChecklistId
  label: string
  done: boolean
  /** What is missing, each naming its field. Empty when done. */
  missing: string[]
}

function validLossLimit(n: unknown): n is number {
  return finite(n) && n > 0
}

function validMaxAttempts(n: unknown): n is number {
  return finite(n) && Number.isInteger(n) && n >= 1
}

function levelMissing(l: KeyLevel): string[] {
  const out: string[] = []
  if (!filled(l.label)) out.push('label')
  if (!finite(l.price) || l.price <= 0) out.push('price')
  if (l.type === null) out.push('type')
  if (l.liquidity === null) out.push('internal/external')
  if (l.status === null) out.push('status')
  return out
}

function scenarioMissing(k: ScenarioKey, s: Scenario): string[] {
  const out: string[] = []
  if (!filled(s.if)) out.push('IF')
  if (!filled(s.then)) out.push('THEN')
  if (!filled(s.invalidation)) out.push(k === 'noTrade' ? 'cancel condition' : 'invalidation')
  // A no-trade scenario has nothing to target and nothing it trades into.
  if (k !== 'noTrade') {
    if (!filled(s.opposingLiquidity)) out.push('opposing liquidity')
    if (!filled(s.targets)) out.push('targets')
  }
  return out
}

function eventMissing(e: PlanEvent): string[] {
  const out: string[] = []
  if (!HHMM.test(e.time)) out.push('time (HH:MM ET)')
  if (!filled(e.name)) out.push('name')
  if (!finite(e.beforeMin) || e.beforeMin < 0) out.push('minutes before')
  if (!finite(e.afterMin) || e.afterMin < 0) out.push('minutes after')
  return out
}

/** The pre-session checklist, derived from the fields. Nothing here can be ticked. */
export function planChecklist(b: PlanBody): ChecklistItem[] {
  const item = (id: ChecklistId, label: string, missing: string[]): ChecklistItem => ({ id, label, done: missing.length === 0, missing })

  const levels: string[] = b.levels.length === 0 ? ['Map at least one key level.'] : []
  b.levels.forEach((l, i) => {
    const m = levelMissing(l)
    if (m.length) levels.push(`Level ${i + 1}: enter the ${m.join(', ')}.`)
  })

  const scenarios: string[] = []
  for (const k of SCENARIO_KEYS) {
    const m = scenarioMissing(k, b.scenarios[k])
    if (m.length) scenarios.push(`${SCENARIO_LABELS[k]} scenario: write the ${m.join(', ')}.`)
  }

  const risk: string[] = []
  if (!validLossLimit(b.lossLimit)) risk.push('Write the daily loss limit ($, above zero).')
  if (!validMaxAttempts(b.maxAttempts)) risk.push('Write the maximum attempts (a whole number, at least 1).')

  const events: string[] = []
  if (!filled(b.eventsChecked)) events.push('Say where the economic calendar was checked — required even when nothing is scheduled.')
  b.events.forEach((e, i) => {
    const m = eventMissing(e)
    if (m.length) events.push(`Event ${i + 1}: enter the ${m.join(', ')}.`)
  })

  return [
    item('INSTRUMENTS', 'Instruments in focus', b.instruments.length ? [] : ['Name at least one instrument in focus.']),
    item('SESSION', 'Session profile', b.sessionProfile ? [] : ['Choose the session profile.']),
    item('LEVELS', 'Levels mapped', levels),
    item('SCENARIOS', 'Scenarios written', scenarios),
    item('RISK_LIMITS', 'Loss limit and attempts written', risk),
    item('EVENTS', 'Events reviewed', events),
  ]
}

export function checklistComplete(b: PlanBody): boolean {
  return planChecklist(b).every((i) => i.done)
}

// ─── Freezing, creating, editing ───────────────────────────────────────────

const wasTaken = (e: JournalEntry) => e.status === 'TAKEN' || e.status === 'CLOSED'

/** The earliest entry taken on this ET date, by its fill. */
export function firstTakenOn(entries: readonly JournalEntry[], date: string): JournalEntry | null {
  let best: JournalEntry | null = null
  for (const e of entries) {
    if (!wasTaken(e) || !e.fill || etDate(e.fill.at) !== date) continue
    if (best === null || Date.parse(e.fill.at) < Date.parse(best.fill!.at)) best = e
  }
  return best
}

/**
 * Frozen once a trade on the plan's date is taken, once it has any amendment,
 * and whenever that cannot be ruled out (`entries === null`: the journal could
 * not be read).
 */
export function isFrozen(plan: DailyPlan, entries: readonly JournalEntry[] | null): boolean {
  if (plan.createdAfterFirstTrade !== false || plan.amendments.length > 0) return true
  if (entries === null) return true
  return firstTakenOn(entries, plan.date) !== null
}

export function changedFields(a: PlanBody, b: PlanBody): (keyof PlanBody)[] {
  return (Object.keys(a) as (keyof PlanBody)[]).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
}

export const DATE_UNKNOWN = "Today's trading date is unknown: the backend has not answered, so no plan can be created or edited. Past plans are still shown."

/** A new plan for `date`. Refused when the date is unknown or already has a plan. */
export function createPlan(plans: readonly DailyPlan[], date: string | null, body: PlanBody, now: string,
  entries: readonly JournalEntry[] | null): { plan: DailyPlan } | { error: string } {
  if (date === null || !isPlanDate(date)) return { error: DATE_UNKNOWN }
  if (plans.some((p) => p.date === date)) return { error: `A plan for ${date} already exists. There is one plan per date, and it is never replaced.` }
  return {
    plan: {
      schema: PLAN_SCHEMA, date, createdAt: now, updatedAt: now, body,
      createdAfterFirstTrade: entries === null ? null : firstTakenOn(entries, date) !== null,
      amendments: [],
    },
  }
}

/**
 * Save `body` to today's plan. Before the freeze it replaces the plan; after
 * it, it is appended as an amendment and `body` is left as written. Only
 * today's plan (the backend's date) can be edited.
 */
export function editPlan(plan: DailyPlan, body: PlanBody, now: string, today: string | null,
  entries: readonly JournalEntry[] | null): { plan: DailyPlan; result: 'REPLACED' | 'AMENDED' | 'UNCHANGED' } | { error: string } {
  if (today === null) return { error: DATE_UNKNOWN }
  if (plan.date !== today) return { error: `Only today's plan (${today}) can be edited. The plan for ${plan.date} is a record.` }
  const changed = changedFields(effectiveBody(plan), body)
  if (changed.length === 0) return { plan, result: 'UNCHANGED' }
  if (!isFrozen(plan, entries)) return { plan: { ...plan, body, updatedAt: now }, result: 'REPLACED' }
  return { plan: { ...plan, updatedAt: now, amendments: [...plan.amendments, { at: now, body, changed }] }, result: 'AMENDED' }
}

// ─── The day, from the journal ─────────────────────────────────────────────

export interface DayRisk {
  date: string
  /** Trades whose last exit fell on the date. */
  closed: number
  /** P&L counted under the rules in the header. */
  realizedPnl: number
  /** max(0, −realizedPnl). */
  realizedLoss: number
  /** Losing trades with no fees entered, counted at gross. */
  lossesWithoutFees: number
  /** Winning trades with no fees entered, left out. */
  winsWithoutFees: number
  /** Closed trades whose exits do not cover the fill. */
  unmeasurable: number
  /** Σ R over trades closed on the date with a measured R; null when there are none. */
  realizedR: number | null
  measuredR: number
  stopOuts: number
  /** Entries taken on the date (fill's ET date), open or closed. */
  attempts: number
}

export function dayRisk(entries: readonly JournalEntry[], date: string): DayRisk {
  const d: DayRisk = {
    date, closed: 0, realizedPnl: 0, realizedLoss: 0, lossesWithoutFees: 0, winsWithoutFees: 0,
    unmeasurable: 0, realizedR: null, measuredR: 0, stopOuts: stopOutsOn(entries, date), attempts: 0,
  }
  let r = 0
  for (const e of entries) {
    if (wasTaken(e) && e.fill && etDate(e.fill.at) === date) d.attempts++
    if (e.status !== 'CLOSED') continue
    const at = closedAt(e)
    if (!at || etDate(at) !== date) continue
    d.closed++
    const gross = grossPnl(e)
    if (gross === null) { d.unmeasurable++; continue }
    if (e.fees !== null) d.realizedPnl += gross - e.fees
    else if (gross < 0) { d.realizedPnl += gross; d.lossesWithoutFees++ }
    else d.winsWithoutFees++
    const er = evaluateEntry(e, entries).realized?.r
    if (er !== null && er !== undefined) { r += er; d.measuredR++ }
  }
  d.realizedLoss = Math.max(0, -d.realizedPnl)
  d.realizedR = d.measuredR ? r : null
  return d
}

// ─── What the ticket reads ─────────────────────────────────────────────────

export interface StoreView<T> {
  ready: boolean
  error: string | null
  items: readonly T[]
}

/**
 * The plan context for the ticket on `date` (the backend's). The journal is
 * read for the day's figures; an unreadable journal gives `day: null`, which
 * tightens nothing — a missing record proves nothing.
 */
export function planContextFor(date: string | null, plans: StoreView<DailyPlan>, journal: StoreView<JournalEntry>): PlanContext {
  if (!plans.ready) return { status: 'UNAVAILABLE', reason: 'The stored plans have not loaded yet.' }
  if (plans.error) return { status: 'UNAVAILABLE', reason: `The stored plans could not be read: ${plans.error}` }
  if (date === null) {
    return { status: 'UNAVAILABLE', reason: "The backend has not answered, so today's ET date is unknown and no plan can be matched to it." }
  }
  const plan = plans.items.find((p) => p.date === date)
  if (!plan) return { status: 'NOT_WRITTEN', date }
  const missing = planChecklist(plan.body).flatMap((i) => i.missing)
  const { lossLimit, maxAttempts } = strictestLimits(plan)
  const day = journal.ready && !journal.error ? dayRisk(journal.items, date) : null
  return {
    status: 'WRITTEN', date, missing, lossLimit, maxAttempts, windows: planWindows(plan),
    day: day && { realizedLoss: day.realizedLoss, lossesWithoutFees: day.lossesWithoutFees, attempts: day.attempts },
  }
}

// ─── The form ──────────────────────────────────────────────────────────────

export interface DraftLevel { label: string; price: string; type: LevelType | ''; liquidity: Liquidity | ''; status: LevelStatus | '' }
export interface DraftEvent { time: string; name: string; before: string; after: string }

/** The plan as the form holds it: text as typed, parsed only on save. */
export interface PlanDraft {
  instruments: string
  htfBias: Bias | null
  sessionProfile: SessionProfileId | ''
  levels: DraftLevel[]
  rangeHigh: string
  rangeLow: string
  scenarios: Record<ScenarioKey, Scenario>
  events: DraftEvent[]
  eventsChecked: string
  lossLimit: string
  maxAttempts: string
}

export function emptyDraft(): PlanDraft {
  return draftFromBody(emptyBody())
}

const text = (n: number | null) => (n === null ? '' : String(n))

export function draftFromBody(b: PlanBody): PlanDraft {
  return {
    instruments: b.instruments.join(', '),
    htfBias: b.htfBias,
    sessionProfile: b.sessionProfile ?? '',
    levels: b.levels.map((l) => ({ label: l.label, price: text(l.price), type: l.type ?? '', liquidity: l.liquidity ?? '', status: l.status ?? '' })),
    rangeHigh: text(b.range.high),
    rangeLow: text(b.range.low),
    scenarios: {
      primary: { ...b.scenarios.primary }, alternate: { ...b.scenarios.alternate }, noTrade: { ...b.scenarios.noTrade },
    },
    events: b.events.map((e) => ({ time: e.time, name: e.name, before: text(e.beforeMin), after: text(e.afterMin) })),
    eventsChecked: b.eventsChecked,
    lossLimit: text(b.lossLimit),
    maxAttempts: text(b.maxAttempts),
  }
}

/**
 * Parse the form. An empty field is saved as not written (the checklist names
 * it); a field that holds something that is not a usable value is an error,
 * named, and the plan is not saved until it is fixed.
 */
export function bodyFromDraft(d: PlanDraft): { body: PlanBody; errors: string[] } {
  const errors: string[] = []
  const num = (raw: string, label: string, rule: 'positive' | 'nonNegativeInt' | 'positiveInt'): number | null => {
    const t = raw.trim()
    if (t === '') return null
    const n = Number(t)
    if (!Number.isFinite(n)) { errors.push(`${label}: "${t}" is not a number.`); return null }
    if (rule === 'positive' && n <= 0) { errors.push(`${label} must be above zero.`); return null }
    if (rule === 'positiveInt' && (!Number.isInteger(n) || n < 1)) { errors.push(`${label} must be a whole number, at least 1.`); return null }
    if (rule === 'nonNegativeInt' && (!Number.isInteger(n) || n < 0)) { errors.push(`${label} must be a whole number of minutes, 0 or more.`); return null }
    return n
  }

  const instruments: string[] = []
  for (const raw of d.instruments.split(/[\s,]+/)) {
    const s = raw.trim().toUpperCase()
    if (s === '') continue
    if (!/^[A-Z0-9.!/]{1,12}$/.test(s)) { errors.push(`Instrument "${raw.trim()}" is not a symbol.`); continue }
    if (!instruments.includes(s)) instruments.push(s)
  }

  const levels: KeyLevel[] = []
  d.levels.forEach((l, i) => {
    const blank = !filled(l.label) && !filled(l.price) && l.type === '' && l.liquidity === '' && l.status === ''
    if (blank) return
    levels.push({
      label: l.label.trim(), price: num(l.price, `Level ${i + 1} price`, 'positive'),
      type: l.type === '' ? null : l.type, liquidity: l.liquidity === '' ? null : l.liquidity, status: l.status === '' ? null : l.status,
    })
  })

  const high = num(d.rangeHigh, 'Dealing range high', 'positive')
  const low = num(d.rangeLow, 'Dealing range low', 'positive')
  if ((high === null) !== (low === null) && !errors.some((e) => e.startsWith('Dealing range'))) {
    errors.push('Dealing range: enter both the high and the low, or neither.')
  }
  if (high !== null && low !== null && high <= low) errors.push('Dealing range: the high must be above the low.')

  const events: PlanEvent[] = []
  d.events.forEach((e, i) => {
    const blank = !filled(e.time) && !filled(e.name) && !filled(e.before) && !filled(e.after)
    if (blank) return
    const time = e.time.trim()
    if (time !== '' && !HHMM.test(time)) errors.push(`Event ${i + 1} time must be HH:MM, 24-hour ET.`)
    events.push({
      time, name: e.name.trim(),
      beforeMin: num(e.before, `Event ${i + 1} minutes before`, 'nonNegativeInt'),
      afterMin: num(e.after, `Event ${i + 1} minutes after`, 'nonNegativeInt'),
    })
  })

  const trim = (s: Scenario): Scenario => ({
    if: s.if.trim(), then: s.then.trim(), invalidation: s.invalidation.trim(),
    opposingLiquidity: s.opposingLiquidity.trim(), targets: s.targets.trim(),
  })

  const body: PlanBody = {
    instruments,
    htfBias: d.htfBias,
    sessionProfile: d.sessionProfile === '' ? null : d.sessionProfile,
    levels,
    range: { high, low },
    scenarios: { primary: trim(d.scenarios.primary), alternate: trim(d.scenarios.alternate), noTrade: trim(d.scenarios.noTrade) },
    events,
    eventsChecked: d.eventsChecked.trim(),
    lossLimit: num(d.lossLimit, 'Daily loss limit', 'positive'),
    maxAttempts: num(d.maxAttempts, 'Maximum attempts', 'positiveInt'),
  }
  return { body, errors }
}

// ─── Shape check ───────────────────────────────────────────────────────────

const str = (v: unknown): v is string => typeof v === 'string'
const numOrNull = (v: unknown) => v === null || finite(v)
const oneOf = <T extends string>(list: readonly T[], v: unknown) => v === null || (str(v) && (list as readonly string[]).includes(v))

function isScenario(v: unknown): v is Scenario {
  const s = v as Partial<Scenario> | null
  return !!s && str(s.if) && str(s.then) && str(s.invalidation) && str(s.opposingLiquidity) && str(s.targets)
}

export function isBody(v: unknown): v is PlanBody {
  const b = v as Partial<PlanBody> | null
  if (!b || typeof b !== 'object') return false
  return Array.isArray(b.instruments) && b.instruments.every(str)
    && (b.htfBias === null || b.htfBias === 'BULLISH' || b.htfBias === 'BEARISH')
    && (b.sessionProfile === null || (str(b.sessionProfile) && b.sessionProfile in SESSION_PROFILES))
    && Array.isArray(b.levels) && b.levels.every((l) => !!l && str(l.label) && numOrNull(l.price)
      && oneOf(LEVEL_TYPES, l.type) && oneOf(LIQUIDITY, l.liquidity) && oneOf(LEVEL_STATUSES, l.status))
    && !!b.range && numOrNull(b.range.high) && numOrNull(b.range.low)
    && !!b.scenarios && SCENARIO_KEYS.every((k) => isScenario(b.scenarios![k]))
    && Array.isArray(b.events) && b.events.every((e) => !!e && str(e.time) && str(e.name) && numOrNull(e.beforeMin) && numOrNull(e.afterMin))
    && str(b.eventsChecked)
    && numOrNull(b.lossLimit) && numOrNull(b.maxAttempts)
}

export function isPlan(v: unknown): v is DailyPlan {
  const p = v as Partial<DailyPlan> | null
  if (!p || typeof p !== 'object') return false
  return p.schema === PLAN_SCHEMA && isPlanDate(p.date) && str(p.createdAt) && str(p.updatedAt)
    && isBody(p.body)
    && (p.createdAfterFirstTrade === null || typeof p.createdAfterFirstTrade === 'boolean')
    && Array.isArray(p.amendments)
    && p.amendments.every((a) => !!a && str(a.at) && isBody(a.body) && Array.isArray(a.changed))
}
