/**
 * The daily plan, and what it may do to the ticket.
 *
 * Each block holds one rule. The plan's arithmetic (EQ, windows, the day's
 * loss) is checked against hand-worked numbers; the checklist is broken one
 * field at a time; the freeze is driven through the journal entries that
 * cause it; and the ticket is checked across a matrix so that "the plan only
 * tightens, and passes only itself" is a property, not an example.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DATE_UNKNOWN, bodyFromDraft, changedFields, checklistComplete, createPlan, dayRisk, dealingRange, draftFromBody,
  editPlan, emptyBody, emptyDraft, eventClock, eventWindow, firstTakenOn, isFrozen, isPlan, planChecklist,
  planContextFor, planDateFrom, planWindows, strictestLimits, zoneOf,
  type ChecklistId, type DailyPlan, type PlanBody,
} from '@/lib/dailyPlan'
import { PLAN_STORAGE_KEY, parsePlans, serializePlans } from '@/lib/dailyPlanStore'
import { createEntry, type Exit, type JournalEntry } from '@/lib/journal'
import {
  evaluateTicket, minutesOf, planGate, ticketRecord, visibleGates,
  type PlanContext, type TicketInput,
} from '@/lib/tradeTicket'
import { completeBody, completePlan } from './planFixtures'

const DATE = '2026-11-09'
const SPEC = { tickSize: 0.25, tickValue: 12.5, unit: 'contract' as const }

afterEach(() => vi.useRealTimers())

// ─── Ticket fixtures ───────────────────────────────────────────────────────

/** ES long, 10-pt stop, $1,000 budget: 2 contracts at 3R. Every trader gate PASS. */
function ticket(o: Partial<TicketInput> = {}): TicketInput {
  const base: Omit<TicketInput, 'answers'> = {
    symbol: 'ES', spec: { ...SPEC, micro: 'MES' }, contract: 'ESZ6', side: 'LONG', setupId: 'ES-1109-01',
    model: 'TRAP_FADE', sessionProfile: 'ONEPAGER', alsoRequire: { candle23: false, cisd: false },
    narrative: { htfContext: 'a', poi: 'b', liquidityEvent: 'c', invalidation: 'd', cancelCondition: 'e', managementPlan: 'f', screenshot: 'g' },
    entry: 5000, stop: 4990, targets: [{ price: 5030, kind: 'EXTERNAL' }],
    riskBudget: 1000, costPerUnit: 0, slippageTicks: 0, minR: 2,
    clock: { state: 'OPEN', nowMinutesEt: minutesOf('10:00'), closeMinutesEt: minutesOf('16:00') },
    ...o,
  }
  const answers: TicketInput['answers'] = {}
  for (const { def } of visibleGates({ ...base, answers: {} })) answers[def.id] = 'PASS'
  return { ...base, answers: o.answers ?? answers }
}

const written = (o: Partial<Extract<PlanContext, { status: 'WRITTEN' }>> = {}): PlanContext => ({
  status: 'WRITTEN', date: DATE, missing: [], lossLimit: 500, maxAttempts: 2,
  windows: [{ name: 'CPI', time: '08:30', start: minutesOf('08:25'), end: minutesOf('08:45') }],
  day: { realizedLoss: 0, lossesWithoutFees: 0, attempts: 0 },
  ...o,
})

/** Every kind of plan context, including ones that tighten. */
const PLANS: PlanContext[] = [
  { status: 'UNAVAILABLE', reason: 'test' },
  { status: 'NOT_WRITTEN', date: DATE },
  written(),
  written({ missing: ['Write the daily loss limit ($, above zero).'], lossLimit: null }),
  written({ day: { realizedLoss: 500, lossesWithoutFees: 1, attempts: 0 } }),
  written({ day: { realizedLoss: 0, lossesWithoutFees: 0, attempts: 2 } }),
  written({ day: null }),
  written({ windows: [{ name: 'FOMC', time: '10:00', start: minutesOf('09:45'), end: minutesOf('10:30') }] }),
]

/** Every kind of ticket, the plan's gate aside. */
const answered = ticket()
const without = (id: keyof TicketInput['answers']) => {
  const a = { ...answered.answers }
  delete a[id]
  return a
}
const TICKETS: TicketInput[] = [
  ticket(), ticket({ side: null }), ticket({ clock: null }), ticket({ targets: [] }), ticket({ riskBudget: 400 }),
  ticket({ answers: { ...answered.answers, retest: 'FAIL' } }), ticket({ answers: { ...answered.answers, dailyLock: 'FAIL' } }),
  ticket({ answers: without('dailyLock') }), ticket({ answers: without('firstAttempt') }), ticket({ answers: {} }),
  ticket({ clock: { state: 'OPEN', nowMinutesEt: minutesOf('08:30'), closeMinutesEt: minutesOf('16:00') } }),
  ticket({ clock: { state: 'OPEN', nowMinutesEt: null, closeMinutesEt: minutesOf('16:00') } }),
  ticket({ sessionProfile: null }), ticket({ journal: { priorAttempts: 0, stopOutsToday: 2 } }),
]

// ─── The date ──────────────────────────────────────────────────────────────

describe('the date is the backend\'s', () => {
  test('planDateFrom reads session.date and nothing else', () => {
    // The browser's clock says the 12th; the backend says the 9th. The 9th wins.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-12T15:00:00.000Z'))
    expect(planDateFrom({ date: DATE })).toBe(DATE)
    expect(planDateFrom(null)).toBeNull()
    expect(planDateFrom(undefined)).toBeNull()
    expect(planDateFrom({ date: null })).toBeNull()
    expect(planDateFrom({ date: '2026-13-45' })).toBeNull()
    expect(planDateFrom({ date: '2026-02-30' })).toBeNull()
    expect(planDateFrom({ date: 20261109 })).toBeNull()
  })

  test('no date, no plan: creating and editing both refuse', () => {
    expect(createPlan([], null, completeBody(), 'now', [])).toEqual({ error: DATE_UNKNOWN })
    expect(editPlan(completePlan(DATE), completeBody({ lossLimit: 400 }), 'now', null, [])).toEqual({ error: DATE_UNKNOWN })
  })
})

// ─── The dealing range ─────────────────────────────────────────────────────

describe('the dealing range', () => {
  test('EQ is the midpoint of the high and the low', () => {
    // Asymmetric numbers, so a formula on the wrong bounds cannot land on it.
    expect(dealingRange(110, 90)).toEqual({ high: 110, low: 90, eq: 100 })
    expect(dealingRange(5030, 4970)?.eq).toBe(5000)
    expect(dealingRange(4.5, 4.25)?.eq).toBe(4.375)
  })

  test('no range without both bounds, or with the high not above the low', () => {
    expect(dealingRange(null, 90)).toBeNull()
    expect(dealingRange(110, null)).toBeNull()
    expect(dealingRange(100, 100)).toBeNull()
    expect(dealingRange(90, 110)).toBeNull()
  })

  test('above EQ is premium, below is discount, EQ itself is neither', () => {
    const r = dealingRange(110, 90)!
    expect(zoneOf(105, r)).toBe('PREMIUM')
    expect(zoneOf(95, r)).toBe('DISCOUNT')
    expect(zoneOf(100, r)).toBe('EQUILIBRIUM')
    expect(zoneOf(110, r)).toBe('PREMIUM')
    expect(zoneOf(90, r)).toBe('DISCOUNT')
    expect(zoneOf(111, r)).toBe('ABOVE_RANGE')
    expect(zoneOf(89, r)).toBe('BELOW_RANGE')
  })
})

// ─── The checklist ─────────────────────────────────────────────────────────

describe('the checklist is derived from the fields, never ticked', () => {
  const done = (b: PlanBody) => Object.fromEntries(planChecklist(b).map((i) => [i.id, i.done])) as Record<ChecklistId, boolean>

  test('an empty plan has every item open, each saying what is missing', () => {
    const items = planChecklist(emptyBody())
    expect(items.map((i) => i.id)).toEqual(['INSTRUMENTS', 'SESSION', 'LEVELS', 'SCENARIOS', 'RISK_LIMITS', 'EVENTS'])
    for (const i of items) {
      expect(i.done, i.id).toBe(false)
      expect(i.missing.length, i.id).toBeGreaterThan(0)
    }
  })

  test('a complete plan has every item done', () => {
    expect(planChecklist(completeBody()).every((i) => i.done)).toBe(true)
    expect(checklistComplete(completeBody())).toBe(true)
  })

  test('the checklist takes the plan and nothing else: there is no tick to pass in', () => {
    expect(planChecklist.length).toBe(1)
    const src = readFileSync(join(__dirname, '..', 'app', 'prep', 'page.tsx'), 'utf8')
    expect(src).not.toMatch(/type="checkbox"/)
  })

  test.each<[ChecklistId, Partial<PlanBody>]>([
    ['INSTRUMENTS', { instruments: [] }],
    ['SESSION', { sessionProfile: null }],
    ['LEVELS', { levels: [] }],
    // One complete level does not cover an incomplete one.
    ['LEVELS', { levels: [...completeBody().levels, { label: 'VWAP', price: 5001, type: 'VWAP', liquidity: 'INTERNAL', status: null }] }],
    ['LEVELS', { levels: [{ label: 'PDH', price: 0, type: 'PDH', liquidity: 'EXTERNAL', status: 'FRESH' }] }],
    ['LEVELS', { levels: [{ label: ' ', price: 5030, type: 'PDH', liquidity: 'EXTERNAL', status: 'FRESH' }] }],
    ['SCENARIOS', { scenarios: { ...completeBody().scenarios, primary: { ...completeBody().scenarios.primary, targets: '' } } }],
    ['SCENARIOS', { scenarios: { ...completeBody().scenarios, alternate: { ...completeBody().scenarios.alternate, then: ' ' } } }],
    ['SCENARIOS', { scenarios: { ...completeBody().scenarios, noTrade: { ...completeBody().scenarios.noTrade, invalidation: '' } } }],
    ['RISK_LIMITS', { lossLimit: null }],
    ['RISK_LIMITS', { lossLimit: 0 }],
    ['RISK_LIMITS', { maxAttempts: null }],
    ['RISK_LIMITS', { maxAttempts: 0 }],
    ['RISK_LIMITS', { maxAttempts: 1.5 }],
    // "No events today" is still an answer that has to be written.
    ['EVENTS', { events: [], eventsChecked: '' }],
    ['EVENTS', { eventsChecked: '  ' }],
    ['EVENTS', { events: [{ time: '08:30', name: 'CPI', beforeMin: 5, afterMin: null }] }],
    ['EVENTS', { events: [{ time: '8:30', name: 'CPI', beforeMin: 5, afterMin: 15 }] }],
    ['EVENTS', { events: [{ time: '08:30', name: '', beforeMin: 5, afterMin: 15 }] }],
  ])('%s is open when its field is not filled (%#)', (id, patch) => {
    const d = done(completeBody(patch))
    expect(d[id]).toBe(false)
    for (const [k, v] of Object.entries(d)) if (k !== id) expect(v, k).toBe(true)
  })

  test('a no-trade scenario needs no targets or opposing liquidity; a zero-event day needs only where it was checked', () => {
    expect(done(completeBody())['SCENARIOS']).toBe(true)
    expect(done(completeBody({ events: [], eventsChecked: 'BLS + Fed calendars, nothing scheduled' }))['EVENTS']).toBe(true)
  })
})

// ─── The form ──────────────────────────────────────────────────────────────

describe('the form', () => {
  test('an empty draft saves nothing as written and reports no error', () => {
    const { body, errors } = bodyFromDraft(emptyDraft())
    expect(errors).toEqual([])
    expect(body).toEqual(emptyBody())
    expect(body.lossLimit).toBeNull()
    expect(body.maxAttempts).toBeNull()
    expect(body.htfBias).toBeNull()
  })

  test('a complete plan survives the form both ways', () => {
    const b = completeBody()
    expect(bodyFromDraft(draftFromBody(b))).toEqual({ body: b, errors: [] })
  })

  test('what is typed wrong is an error that names its field', () => {
    const d = { ...emptyDraft(), lossLimit: 'five hundred', maxAttempts: '1.5', rangeHigh: '90', rangeLow: '110' }
    const { errors } = bodyFromDraft(d)
    expect(errors).toContain('Daily loss limit: "five hundred" is not a number.')
    expect(errors).toContain('Maximum attempts must be a whole number, at least 1.')
    expect(errors).toContain('Dealing range: the high must be above the low.')
    expect(bodyFromDraft({ ...emptyDraft(), lossLimit: '-5' }).errors).toContain('Daily loss limit must be above zero.')
    expect(bodyFromDraft({ ...emptyDraft(), rangeHigh: '110' }).errors).toContain('Dealing range: enter both the high and the low, or neither.')
    expect(bodyFromDraft({ ...emptyDraft(), events: [{ time: '25:00', name: 'X', before: '5', after: '5' }] }).errors)
      .toContain('Event 1 time must be HH:MM, 24-hour ET.')
    expect(bodyFromDraft({ ...emptyDraft(), events: [{ time: '08:30', name: 'X', before: '2.5', after: '5' }] }).errors)
      .toContain('Event 1 minutes before must be a whole number of minutes, 0 or more.')
  })

  test('instruments are read as symbols, upper-cased, once each', () => {
    expect(bodyFromDraft({ ...emptyDraft(), instruments: ' es, nq ES  mes' }).body.instruments).toEqual(['ES', 'NQ', 'MES'])
    expect(bodyFromDraft({ ...emptyDraft(), instruments: 'ES, <b>' }).errors).toEqual(['Instrument "<b>" is not a symbol.'])
  })

  test('a blank row is dropped, a partly filled one is kept for the checklist to name', () => {
    const d = { ...emptyDraft(), levels: [
      { label: '', price: '', type: '' as const, liquidity: '' as const, status: '' as const },
      { label: 'PDH', price: '', type: 'PDH' as const, liquidity: '' as const, status: '' as const },
    ] }
    const { body } = bodyFromDraft(d)
    expect(body.levels).toHaveLength(1)
    expect(planChecklist(body).find((i) => i.id === 'LEVELS')!.missing).toEqual(['Level 1: enter the price, internal/external, status.'])
  })
})

// ─── Events ────────────────────────────────────────────────────────────────

describe('stand-aside windows', () => {
  test('time minus before to time plus after, start inclusive, end exclusive', () => {
    expect(eventWindow({ time: '08:30', name: 'CPI', beforeMin: 5, afterMin: 15 })).toEqual({ name: 'CPI', time: '08:30', start: 505, end: 525 })
  })

  test('clipped to the plan\'s own date', () => {
    expect(eventWindow({ time: '00:05', name: 'X', beforeMin: 30, afterMin: 0 })).toMatchObject({ start: 0, end: 5 })
    expect(eventWindow({ time: '23:50', name: 'X', beforeMin: 0, afterMin: 30 })).toMatchObject({ start: 1430, end: 1440 })
  })

  test('no window without a time and both stand-aside figures', () => {
    expect(eventWindow({ time: '08:30', name: 'CPI', beforeMin: null, afterMin: 15 })).toBeNull()
    expect(eventWindow({ time: '8:30', name: 'CPI', beforeMin: 5, afterMin: 15 })).toBeNull()
  })

  test('the next window and the ones now is inside', () => {
    const ws = planWindows(completePlan(DATE, { events: [
      { time: '08:30', name: 'CPI', beforeMin: 5, afterMin: 15 },
      { time: '14:00', name: 'FOMC', beforeMin: 15, afterMin: 30 },
    ] }))
    expect(eventClock(ws, minutesOf('08:00'))).toMatchObject({ inside: [], next: { window: { name: 'CPI' }, minutesToStart: 25 } })
    expect(eventClock(ws, minutesOf('08:25')).inside.map((w) => w.name)).toEqual(['CPI'])
    expect(eventClock(ws, minutesOf('08:45'))).toMatchObject({ inside: [], next: { window: { name: 'FOMC' }, minutesToStart: 300 } })
    expect(eventClock(ws, minutesOf('15:00'))).toEqual({ inside: [], next: null })
  })
})

// ─── Journal fixtures ──────────────────────────────────────────────────────

function journalEntry(o: Partial<JournalEntry>, id: string, setupId = `S-${id}`): JournalEntry {
  const input = ticket({ setupId, plan: written() })
  const made = createEntry(ticketRecord(input, evaluateTicket(input), `${DATE}T13:00:00.000Z`, 'UNVERIFIED'), SPEC, `${DATE}T13:00:00.000Z`, id)
  if ('error' in made) throw new Error(made.error)
  return { ...made.entry, ...o }
}
const fill = (units: number, at = `${DATE}T15:05:00.000Z`) => ({ price: 5000, units, at })
const exit = (price: number, units: number, at = `${DATE}T16:00:00.000Z`): Exit => ({ price, units, at })
const taken = (id: string, at = `${DATE}T15:05:00.000Z`) => journalEntry({ status: 'TAKEN', fill: fill(1, at) }, id)
/** 1 ES contract from 5000; each point is $50. */
const closedTrade = (id: string, exitPrice: number, fees: number | null, at = `${DATE}T16:00:00.000Z`) =>
  journalEntry({ status: 'CLOSED', fill: fill(1), exits: [exit(exitPrice, 1, at)], fees }, id)

// ─── Freezing and amendments ───────────────────────────────────────────────

describe('a plan freezes at the first taken trade of its date', () => {
  const plan = completePlan(DATE)

  test('before any trade, saving replaces the plan', () => {
    const r = editPlan(plan, completeBody({ lossLimit: 400 }), 'T1', DATE, [journalEntry({}, 'p'), journalEntry({ status: 'PASSED' }, 'q')])
    expect(r).toMatchObject({ result: 'REPLACED' })
    if ('error' in r) throw new Error(r.error)
    expect(r.plan.body.lossLimit).toBe(400)
    expect(r.plan.amendments).toEqual([])
  })

  test('after a TAKEN entry on its date, an edit is an amendment and the plan as written is kept', () => {
    const entries = [taken('a')]
    expect(firstTakenOn(entries, DATE)?.id).toBe('a')
    expect(isFrozen(plan, entries)).toBe(true)
    const r = editPlan(plan, completeBody({ lossLimit: 900, htfBias: 'BEARISH' }), '2026-11-09T16:30:00.000Z', DATE, entries)
    if ('error' in r) throw new Error(r.error)
    expect(r.result).toBe('AMENDED')
    expect(r.plan.body).toEqual(plan.body)
    expect(r.plan.amendments).toEqual([{ at: '2026-11-09T16:30:00.000Z', body: completeBody({ lossLimit: 900, htfBias: 'BEARISH' }), changed: ['htfBias', 'lossLimit'] }])
  })

  test('a closed trade freezes it too; a trade on another date does not', () => {
    expect(isFrozen(plan, [closedTrade('c', 4990, 5)])).toBe(true)
    expect(isFrozen(plan, [taken('b', '2026-11-10T15:05:00.000Z')])).toBe(false)
  })

  test('a journal that cannot be read is treated as frozen', () => {
    expect(isFrozen(plan, null)).toBe(true)
    expect(editPlan(plan, completeBody({ lossLimit: 400 }), 'T1', DATE, null)).toMatchObject({ result: 'AMENDED' })
  })

  test('once amended it stays frozen, even if the journal no longer shows the trade', () => {
    const r = editPlan(plan, completeBody({ lossLimit: 400 }), 'T1', DATE, [taken('a')])
    if ('error' in r) throw new Error(r.error)
    expect(isFrozen(r.plan, [])).toBe(true)
  })

  test('a plan written after the first trade starts frozen', () => {
    const made = createPlan([], DATE, completeBody(), 'T0', [taken('a')])
    if ('error' in made) throw new Error(made.error)
    expect(made.plan.createdAfterFirstTrade).toBe(true)
    expect(editPlan(made.plan, completeBody({ lossLimit: 400 }), 'T1', DATE, [])).toMatchObject({ result: 'AMENDED' })
    const unknown = createPlan([], DATE, completeBody(), 'T0', null)
    if ('error' in unknown) throw new Error(unknown.error)
    expect(unknown.plan.createdAfterFirstTrade).toBeNull()
    expect(isFrozen(unknown.plan, [])).toBe(true)
  })

  test('one plan per date; a past plan is a record; an unchanged save changes nothing', () => {
    expect(createPlan([plan], DATE, completeBody(), 'T', [])).toMatchObject({ error: expect.stringMatching(/already exists/) })
    expect(editPlan(plan, completeBody({ lossLimit: 1 }), 'T', '2026-11-10', [])).toMatchObject({ error: expect.stringMatching(/is a record/) })
    expect(editPlan(plan, completeBody(), 'T', DATE, [taken('a')])).toEqual({ plan, result: 'UNCHANGED' })
  })

  test('changedFields names exactly what differs', () => {
    expect(changedFields(completeBody(), completeBody({ maxAttempts: 3, eventsChecked: 'x' }))).toEqual(['eventsChecked', 'maxAttempts'])
    expect(changedFields(completeBody(), completeBody())).toEqual([])
  })
})

describe('amendments can only tighten what the ticket reads', () => {
  const frozen = (bodies: Partial<PlanBody>[]): DailyPlan => {
    let p = completePlan(DATE)
    bodies.forEach((b, i) => {
      const r = editPlan(p, completeBody(b), `T${i}`, DATE, [taken('a')])
      if ('error' in r) throw new Error(r.error)
      p = r.plan
    })
    return p
  }

  test('a raised limit does not loosen; a lowered one tightens', () => {
    expect(strictestLimits(frozen([{ lossLimit: 900, maxAttempts: 5 }]))).toEqual({ lossLimit: 500, maxAttempts: 2 })
    expect(strictestLimits(frozen([{ lossLimit: 300, maxAttempts: 1 }]))).toEqual({ lossLimit: 300, maxAttempts: 1 })
  })

  test('a window removed by an amendment still holds; one added holds too', () => {
    const p = frozen([{ events: [{ time: '14:00', name: 'FOMC', beforeMin: 15, afterMin: 30 }] }])
    expect(planWindows(p).map((w) => w.name)).toEqual(['CPI', 'FOMC'])
  })

  test('an amendment cannot complete a plan after the first trade', () => {
    let p = completePlan(DATE, { lossLimit: null })
    const r = editPlan(p, completeBody(), 'T1', DATE, [taken('a')])
    if ('error' in r) throw new Error(r.error)
    p = r.plan
    const ctx = planContextFor(DATE, { ready: true, error: null, items: [p] }, { ready: true, error: null, items: [taken('a')] })
    expect(ctx).toMatchObject({ status: 'WRITTEN', missing: ['Write the daily loss limit ($, above zero).'] })
  })
})

// ─── The day, from the journal ─────────────────────────────────────────────

describe("the day's realized loss and attempts", () => {
  test('net where fees are entered; a loss without fees at gross; a win without fees left out', () => {
    const d = dayRisk([
      closedTrade('a', 4995, 5),      // −$250 − $5 = −$255
      closedTrade('b', 4996, null),   // −$200 gross, fees not entered: counts −$200, at least
      closedTrade('c', 5010, null),   // +$500 gross, fees not entered: left out
      closedTrade('d', 5002, 5),      // +$100 − $5 = +$95
    ], DATE)
    expect(d.realizedPnl).toBe(-360)
    expect(d.realizedLoss).toBe(360)
    expect(d.lossesWithoutFees).toBe(1)
    expect(d.winsWithoutFees).toBe(1)
    expect(d.closed).toBe(4)
    expect(d.attempts).toBe(4)
    expect(d.stopOuts).toBe(2)
  })

  test('only the plan\'s date counts, by the ET date of the last exit and of the fill', () => {
    // 03:30Z on the 10th is 22:30 ET on the 9th.
    const d = dayRisk([
      closedTrade('a', 4990, 0, '2026-11-10T03:30:00.000Z'),
      closedTrade('b', 4990, 0, '2026-11-10T15:00:00.000Z'),
      taken('c', '2026-11-10T15:00:00.000Z'),
      taken('e'),
    ], DATE)
    expect(d.realizedLoss).toBe(500)
    expect(d.attempts).toBe(3)
  })

  test('a winning day is no loss, and exits that do not cover the fill are counted apart', () => {
    const short = journalEntry({ status: 'CLOSED', fill: fill(2), exits: [exit(5010, 1)], fees: 0 }, 'x')
    const d = dayRisk([closedTrade('a', 5010, 0), short], DATE)
    expect(d.realizedPnl).toBe(500)
    expect(d.realizedLoss).toBe(0)
    expect(d.unmeasurable).toBe(1)
  })
})

describe('what the ticket is given', () => {
  const plans = (items: DailyPlan[], o: Partial<{ ready: boolean; error: string | null }> = {}) => ({ ready: true, error: null, items, ...o })
  const journal = (items: JournalEntry[], o: Partial<{ ready: boolean; error: string | null }> = {}) => ({ ready: true, error: null, items, ...o })

  test('unavailable until the date and the plans are known', () => {
    expect(planContextFor(DATE, plans([], { ready: false }), journal([])).status).toBe('UNAVAILABLE')
    expect(planContextFor(DATE, plans([], { error: 'bad' }), journal([])).status).toBe('UNAVAILABLE')
    expect(planContextFor(null, plans([completePlan(DATE)]), journal([])).status).toBe('UNAVAILABLE')
  })

  test('another date\'s plan is not today\'s', () => {
    expect(planContextFor(DATE, plans([completePlan('2026-11-06')]), journal([]))).toEqual({ status: 'NOT_WRITTEN', date: DATE })
  })

  test('a written plan carries its limits, windows and the day\'s figures', () => {
    const ctx = planContextFor(DATE, plans([completePlan(DATE)]), journal([closedTrade('a', 4990, 0)]))
    expect(ctx).toEqual({
      status: 'WRITTEN', date: DATE, missing: [], lossLimit: 500, maxAttempts: 2,
      windows: [{ name: 'CPI', time: '08:30', start: 505, end: 525 }],
      day: { realizedLoss: 500, lossesWithoutFees: 0, attempts: 1 },
    })
  })

  test('an unreadable journal gives no day figures, which tighten nothing', () => {
    expect(planContextFor(DATE, plans([completePlan(DATE)]), journal([], { error: 'bad' }))).toMatchObject({ day: null })
  })
})

// ─── The ticket ────────────────────────────────────────────────────────────

describe('the plan\'s own gate', () => {
  test('PASS only for a written, complete plan; otherwise it waits', () => {
    expect(planGate(null).status).toBe('UNMEASURABLE')
    expect(planGate({ status: 'UNAVAILABLE', reason: 'r' })).toEqual({ status: 'UNMEASURABLE', detail: 'r' })
    expect(planGate({ status: 'NOT_WRITTEN', date: DATE }).status).toBe('UNANSWERED')
    expect(planGate(written({ missing: ['Write X.'] }))).toMatchObject({ status: 'UNANSWERED', detail: expect.stringMatching(/Write X\./) })
    expect(planGate(written()).status).toBe('PASS')
  })

  test('without a plan a complete ticket waits on PLAN_NOT_WRITTEN; it never blocks on it', () => {
    for (const plan of [null, undefined, { status: 'NOT_WRITTEN', date: DATE } as const, written({ missing: ['Write X.'] })]) {
      const r = evaluateTicket(ticket({ plan }))
      expect(r.state).toBe('WAIT_FOR_TRIGGER')
      expect(r.blockers).toEqual([])
      expect(r.gates.find((g) => g.id === 'plan')).toMatchObject({ code: 'PLAN_NOT_WRITTEN', required: true, source: 'COMPUTED' })
    }
    expect(evaluateTicket(ticket({ plan: { status: 'NOT_WRITTEN', date: DATE } })).waiting)
      .toContain('No daily plan is written for 2026-11-09 (ET, the backend\'s date). Write it on the Daily Plan page.')
    expect(evaluateTicket(ticket({ plan: written() })).state).toBe('APPROVED_TRADE')
  })
})

describe('the plan only tightens, and passes only its own gate', () => {
  const otherGates = (r: ReturnType<typeof evaluateTicket>) => r.gates.filter((g) => g.id !== 'plan')

  test('no gate but the plan\'s reads PASS with a plan unless it reads PASS without one — every ticket, every plan', () => {
    for (const t of TICKETS) {
      const base = new Map(evaluateTicket({ ...t, plan: null }).gates.map((g) => [g.id, g.status]))
      for (const plan of PLANS) {
        for (const g of otherGates(evaluateTicket({ ...t, plan }))) {
          if (g.status === 'PASS') expect(base.get(g.id), `${g.id} passed only because of the plan`).toBe('PASS')
        }
      }
    }
  })

  test('nothing in the plan answers a gate the trader left open, or clears one the trader failed', () => {
    const open = ticket({ answers: without('dailyLock') })
    for (const plan of PLANS) {
      const lock = evaluateTicket({ ...open, plan }).gates.find((g) => g.id === 'dailyLock')!
      expect(['UNANSWERED', 'FAIL']).toContain(lock.status)
      const failed = evaluateTicket({ ...ticket({ answers: { ...answered.answers, dailyLock: 'FAIL' } }), plan }).gates.find((g) => g.id === 'dailyLock')!
      expect(failed.status).toBe('FAIL')
    }
  })

  test('where it has nothing to tighten, the verdict is the one without it, the plan\'s own line aside', () => {
    // Written, complete, no limit reached, every window elsewhere in the day.
    const quiet = written()
    for (const t of TICKETS.filter((x) => x.clock?.nowMinutesEt !== minutesOf('08:30') && x.clock?.nowMinutesEt !== null && x.clock !== null)) {
      const a = evaluateTicket({ ...t, plan: quiet })
      const b = evaluateTicket({ ...t, plan: null })
      expect(otherGates(a)).toEqual(otherGates(b))
      expect(a.blockers).toEqual(b.blockers)
      expect(a.sizing).toEqual(b.sizing)
      expect(a.score).toEqual(b.score)
      expect(a.waiting).toEqual(b.waiting.filter((w) => !/^Daily plan cannot be measured/.test(w)))
      // The only verdict that differs is the one the plan's own gate held.
      if (b.state === 'WAIT_FOR_TRIGGER' && b.waiting.length === 1) expect(a.state).toBe('APPROVED_TRADE')
      else expect(a.state).toBe(b.state)
    }
  })
})

describe('the written loss limit and attempts fail the daily lock', () => {
  const lockOf = (plan: PlanContext, o: Partial<TicketInput> = {}) => {
    const r = evaluateTicket(ticket({ plan, ...o }))
    return { r, lock: r.gates.find((g) => g.id === 'dailyLock')! }
  }

  test('a loss equal to the limit reaches it', () => {
    const { r, lock } = lockOf(written({ day: { realizedLoss: 500, lossesWithoutFees: 0, attempts: 0 } }))
    expect(r.state).toBe('BLOCKED')
    expect(r.blockers.map((b) => b.code)).toEqual(['DAILY_LOCK_ACTIVE'])
    expect(lock).toMatchObject({ status: 'FAIL', source: 'COMPUTED' })
    expect(lock.detail).toMatch(/Realized loss on 2026-11-09 is \$500\.00, which reaches the plan's written daily limit of \$500\.00\./)
  })

  test('a cent under the limit does not', () => {
    const { r, lock } = lockOf(written({ day: { realizedLoss: 499.99, lossesWithoutFees: 0, attempts: 0 } }))
    expect(r.state).toBe('APPROVED_TRADE')
    expect(lock.source).toBe('TRADER')
  })

  test('a loss counted without fees says it is a floor', () => {
    expect(lockOf(written({ day: { realizedLoss: 600, lossesWithoutFees: 2, attempts: 0 } })).lock.detail).toMatch(/at least: 2 losing trades have no fees entered/)
  })

  test('the maximum attempts is used up by the last one allowed', () => {
    expect(lockOf(written({ day: { realizedLoss: 0, lossesWithoutFees: 0, attempts: 2 } })).r.blockers.map((b) => b.code)).toEqual(['DAILY_LOCK_ACTIVE'])
    expect(lockOf(written({ day: { realizedLoss: 0, lossesWithoutFees: 0, attempts: 2 } })).lock.detail).toMatch(/2 attempts taken on 2026-11-09, which uses the plan's maximum of 2\./)
    expect(lockOf(written({ day: { realizedLoss: 0, lossesWithoutFees: 0, attempts: 1 } })).r.state).toBe('APPROVED_TRADE')
  })

  test('a lock blocks before a direction is chosen, as every lock does', () => {
    expect(lockOf(written({ day: { realizedLoss: 700, lossesWithoutFees: 0, attempts: 0 } }), { side: null }).r.state).toBe('BLOCKED')
  })

  test('both reasons and the journal\'s stop-outs are all named', () => {
    const { lock } = lockOf(written({ day: { realizedLoss: 700, lossesWithoutFees: 0, attempts: 3 } }), { journal: { priorAttempts: 0, stopOutsToday: 2 } })
    expect(lock.detail).toMatch(/2 losing trades today/)
    expect(lock.detail).toMatch(/\$700\.00/)
    expect(lock.detail).toMatch(/3 attempts/)
  })

  test('with no journal figures, or no limit written, nothing is reached', () => {
    expect(lockOf(written({ day: null })).r.state).toBe('APPROVED_TRADE')
    expect(lockOf(written({ lossLimit: null, maxAttempts: null, day: { realizedLoss: 9999, lossesWithoutFees: 0, attempts: 9 } })).r.state).toBe('APPROVED_TRADE')
  })
})

describe('event stand-aside', () => {
  const at = (hhmm: string | null) => ticket({
    plan: written(),
    clock: { state: 'OPEN', nowMinutesEt: hhmm === null ? null : minutesOf(hhmm), closeMinutesEt: minutesOf('16:00') },
    sessionProfile: 'LEGACY_RESEARCH',   // 08:00–11:30 window, so the session gate itself passes at 08:30
  })
  const gate = (t: TicketInput) => evaluateTicket(t).gates.find((g) => g.id === 'eventStandAside')

  test('inside the window fails, naming the event', () => {
    const r = evaluateTicket(at('08:30'))
    expect(r.state).toBe('BLOCKED')
    expect(r.blockers.map((b) => b.code)).toEqual(['EVENT_STAND_ASIDE'])
    expect(gate(at('08:30'))).toMatchObject({ status: 'FAIL', source: 'COMPUTED', required: true })
    expect(gate(at('08:30'))!.detail).toBe("08:30 ET is inside the plan's stand-aside window for CPI (08:30 ET, 08:25–08:45).")
  })

  test('the window starts inclusive and ends exclusive', () => {
    expect(gate(at('08:25'))?.status).toBe('FAIL')
    expect(gate(at('08:44'))?.status).toBe('FAIL')
    expect(gate(at('08:45'))).toBeUndefined()
    expect(gate(at('08:24'))).toBeUndefined()
  })

  test('outside every window there is no gate, so the verdict is the one without windows', () => {
    const t = at('09:00')
    expect(gate(t)).toBeUndefined()
    expect(evaluateTicket(t)).toEqual(evaluateTicket({ ...t, plan: written({ windows: [] }) }))
    expect(evaluateTicket(t).state).toBe('APPROVED_TRADE')
  })

  test('an unknown clock cannot be measured, and waits; it is never read as outside', () => {
    expect(gate(at(null))).toMatchObject({ status: 'UNMEASURABLE', required: true })
    expect(gate({ ...at('08:30'), clock: null })).toMatchObject({ status: 'UNMEASURABLE' })
    expect(evaluateTicket(at(null)).waiting.some((w) => /^Event stand-aside cannot be measured/.test(w))).toBe(true)
  })

  test('the gate never reads PASS, at any minute of the day', () => {
    for (let m = 0; m < 24 * 60; m += 5) {
      const t = { ...at('09:00'), clock: { state: 'OPEN' as const, nowMinutesEt: m, closeMinutesEt: minutesOf('16:00') } }
      expect(gate(t)?.status).not.toBe('PASS')
    }
  })
})

// ─── Storage ───────────────────────────────────────────────────────────────

describe('plan storage', () => {
  test('an unreadable store is reported and not treated as empty', () => {
    expect(parsePlans('{oops').error).toMatch(/left untouched/)
    expect(parsePlans('{"a":1}').error).toMatch(/not a list/)
    expect(parsePlans(null)).toEqual({ plans: [], rejected: [], error: null })
  })

  test('a plan that fails the shape check, or repeats a date, is counted and kept on save', () => {
    const good = completePlan(DATE)
    const dup = completePlan(DATE, { lossLimit: 9999 })
    const bad = { ...completePlan('2026-11-06'), date: '2026-13-45' }
    const p = parsePlans(JSON.stringify([good, bad, dup, { schema: 'nope' }]))
    expect(p.plans).toEqual([good])
    expect(p.rejected).toHaveLength(3)
    expect(JSON.parse(serializePlans(p.plans, p.rejected))).toHaveLength(4)
  })

  test('every plan the app builds passes its own shape check', () => {
    expect(isPlan(completePlan(DATE))).toBe(true)
    expect(isPlan({ ...completePlan(DATE), body: { ...completeBody(), htfBias: 'NEUTRAL' } })).toBe(false)
    expect(isPlan({ ...completePlan(DATE), body: { ...completeBody(), levels: [{ label: 'x', price: 1, type: 'MADE_UP', liquidity: null, status: null }] } })).toBe(false)
    expect(PLAN_STORAGE_KEY).toBe('quantflow.plans.v1')
  })
})
