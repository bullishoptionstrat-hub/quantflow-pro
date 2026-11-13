/**
 * The Daily Plan page: the date it writes under, what it refuses, and what a
 * save does before and after the first taken trade.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import type { MarketSession, SessionPoll } from '@/lib/marketSession'
import { PLAN_STORAGE_KEY, parsePlans } from '@/lib/dailyPlanStore'
import { STORAGE_KEY as JOURNAL_KEY } from '@/lib/journalStore'
import { createEntry } from '@/lib/journal'
import { evaluateTicket, minutesOf, ticketRecord, visibleGates, type TicketInput } from '@/lib/tradeTicket'
import { completePlan } from './planFixtures'

const DATE = '2026-11-09'

const SESSION = vi.hoisted(() => ({ value: null as unknown }))
vi.mock('@/lib/marketSession', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/marketSession')>()
  return { ...orig, useMarketSession: () => SESSION.value as SessionPoll }
})

import PrepPage from '@/app/prep/page'

const session = (o: Partial<MarketSession> = {}): MarketSession => ({
  state: 'OPEN', date: DATE, nowMinutesEt: minutesOf('08:00'), openMinutesEt: 570, closeMinutesEt: 960,
  basis: 'test', source: 'test', readAt: '2026-11-06', coverage: { from: '2026-01-01', to: '2027-12-31' }, ...o,
})
const ok = (s: MarketSession): SessionPoll => ({ panel: { status: 'ok', data: s }, sources: { status: 'loading' } })

function takenEntry() {
  const base: Omit<TicketInput, 'answers'> = {
    symbol: 'ES', spec: { tickSize: 0.25, tickValue: 12.5, unit: 'contract', micro: 'MES' }, contract: 'ESZ6', side: 'LONG',
    setupId: 'ES-1', model: 'TRAP_FADE', sessionProfile: 'ONEPAGER', alsoRequire: { candle23: false, cisd: false },
    narrative: { htfContext: 'a', poi: 'b', liquidityEvent: 'c', invalidation: 'd', cancelCondition: 'e', managementPlan: 'f', screenshot: 'g' },
    entry: 5000, stop: 4990, targets: [{ price: 5030, kind: 'EXTERNAL' }], riskBudget: 1000, costPerUnit: 0, slippageTicks: 0, minR: 2,
    clock: { state: 'OPEN', nowMinutesEt: 600, closeMinutesEt: 960 },
  }
  const answers: TicketInput['answers'] = {}
  for (const { def } of visibleGates({ ...base, answers: {} })) answers[def.id] = 'PASS'
  const input = { ...base, answers }
  const made = createEntry(ticketRecord(input, evaluateTicket(input), `${DATE}T14:00:00.000Z`, 'UNVERIFIED'),
    { tickSize: 0.25, tickValue: 12.5, unit: 'contract' }, `${DATE}T14:00:00.000Z`, 'j1')
  if ('error' in made) throw new Error(made.error)
  return { ...made.entry, status: 'TAKEN' as const, fill: { price: 5000, units: 1, at: `${DATE}T15:05:00.000Z` } }
}

const set = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

beforeEach(() => {
  window.localStorage.clear()
  SESSION.value = ok(session())
})
afterEach(() => vi.useRealTimers())

describe('the trading date', () => {
  test('is the backend\'s, not the browser\'s, and a plan written by hand is saved under it', async () => {
    // The browser thinks it is the 12th. The backend says the 9th.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-12T15:00:00.000Z'))
    render(<PrepPage />)
    expect(screen.getByTestId('plan-date').textContent).toMatch(/TRADING DATE 2026-11-09/)

    set('INSTRUMENTS IN FOCUS', 'es, nq')
    fireEvent.click(within(screen.getByRole('group', { name: 'HTF bias' })).getByRole('button', { name: 'BULLISH' }))
    set('SESSION PROFILE', 'ONEPAGER')
    fireEvent.click(screen.getByRole('button', { name: '+ Add level' }))
    set('LEVEL 1 LABEL', 'Prior day high')
    set('LEVEL 1 PRICE', '5030')
    set('LEVEL 1 TYPE', 'PDH')
    set('LEVEL 1 LIQUIDITY', 'EXTERNAL')
    set('LEVEL 1 STATUS', 'FRESH')
    set('RANGE HIGH', '5030')
    set('RANGE LOW', '4970')
    for (const k of ['PRIMARY', 'ALTERNATE']) {
      set(`${k} IF`, 'if'); set(`${k} THEN`, 'then'); set(`${k} INVALIDATION`, 'inv')
      set(`${k} OPPOSING LIQUIDITY`, 'opp'); set(`${k} TARGETS`, 'tgt')
    }
    set('NO-TRADE IF', 'chop'); set('NO-TRADE THEN', 'stand aside'); set('NO-TRADE CANCEL CONDITION', 'displacement')
    set('CALENDAR CHECKED (WHERE)', 'BLS calendar')
    fireEvent.click(screen.getByRole('button', { name: '+ Add event' }))
    set('EVENT 1 TIME (ET)', '08:30'); set('EVENT 1 NAME', 'CPI'); set('EVENT 1 MIN BEFORE', '5'); set('EVENT 1 MIN AFTER', '15')
    set('DAILY LOSS LIMIT ($)', '500')
    set('MAX ATTEMPTS', '2')

    expect(screen.getByTestId('plan-range-calc').textContent).toMatch(/EQ 5,000/)
    for (const id of ['INSTRUMENTS', 'SESSION', 'LEVELS', 'SCENARIOS', 'RISK_LIMITS', 'EVENTS']) {
      expect(screen.getByTestId(`check-${id}`).textContent, id).toMatch(/^✓/)
    }
    fireEvent.click(screen.getByRole('button', { name: 'Save plan' }))
    expect(screen.getByTestId('plan-msg').textContent).toBe('Saved the plan for 2026-11-09.')

    const stored = parsePlans(window.localStorage.getItem(PLAN_STORAGE_KEY))
    expect(stored.plans).toHaveLength(1)
    expect(stored.plans[0]!.date).toBe(DATE)
    expect(stored.plans[0]!.body).toMatchObject({ instruments: ['ES', 'NQ'], htfBias: 'BULLISH', lossLimit: 500, maxAttempts: 2 })
    expect(screen.getByTestId('plan-saved-status').textContent).toMatch(/saved plan: COMPLETE/)
  })

  test('with no answer from the backend the date is unknown, nothing can be written, and past plans still show', async () => {
    window.localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify([completePlan('2026-11-06')]))
    SESSION.value = { panel: { status: 'unreachable' }, sources: { status: 'unreachable' } } satisfies SessionPoll
    render(<PrepPage />)
    expect(screen.getByTestId('plan-date').textContent).toMatch(/TRADING DATE UNKNOWN/)
    expect(screen.queryByRole('button', { name: 'Save plan' })).toBeNull()
    expect(screen.queryByLabelText('DAILY LOSS LIMIT ($)')).toBeNull()
    expect(await screen.findByTestId('past-2026-11-06')).toBeTruthy()
  })

  test('a session payload without a date is the same as no answer', () => {
    SESSION.value = ok(session({ date: null }))
    render(<PrepPage />)
    expect(screen.getByTestId('plan-date').textContent).toMatch(/TRADING DATE UNKNOWN/)
  })
})

describe('saving', () => {
  test('before the first taken trade, a save replaces the plan', async () => {
    window.localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify([completePlan(DATE)]))
    render(<PrepPage />)
    await waitFor(() => expect((screen.getByLabelText('DAILY LOSS LIMIT ($)') as HTMLInputElement).value).toBe('500'))
    set('DAILY LOSS LIMIT ($)', '400')
    fireEvent.click(screen.getByRole('button', { name: 'Save plan' }))
    const p = parsePlans(window.localStorage.getItem(PLAN_STORAGE_KEY)).plans[0]!
    expect(p.body.lossLimit).toBe(400)
    expect(p.amendments).toEqual([])
  })

  test('after the first taken trade of the date, a save is an amendment and the plan as written is kept', async () => {
    const original = completePlan(DATE)
    window.localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify([original]))
    window.localStorage.setItem(JOURNAL_KEY, JSON.stringify([takenEntry()]))
    render(<PrepPage />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Record amendment' })).toBeTruthy())
    expect(screen.getByTestId('plan-checklist').textContent).toMatch(/FROZEN · EDITS ARE AMENDMENTS/)
    set('DAILY LOSS LIMIT ($)', '900')
    fireEvent.click(screen.getByRole('button', { name: 'Record amendment' }))
    expect(screen.getByTestId('plan-msg').textContent).toMatch(/Recorded amendment 1/)
    const p = parsePlans(window.localStorage.getItem(PLAN_STORAGE_KEY)).plans[0]!
    expect(p.body).toEqual(original.body)
    expect(p.amendments).toHaveLength(1)
    expect(p.amendments[0]!.body.lossLimit).toBe(900)
    expect(p.amendments[0]!.changed).toEqual(['lossLimit'])
    expect(screen.getByTestId('plan-amendments').textContent).toMatch(/changed lossLimit/)
  })

  test('a field typed wrong is named, and nothing is saved', () => {
    render(<PrepPage />)
    set('DAILY LOSS LIMIT ($)', 'abc')
    expect(screen.getByTestId('plan-errors').textContent).toMatch(/Daily loss limit: "abc" is not a number/)
    fireEvent.click(screen.getByRole('button', { name: 'Save plan' }))
    expect(screen.getByTestId('plan-msg').textContent).toMatch(/^Not saved\./)
    expect(window.localStorage.getItem(PLAN_STORAGE_KEY)).toBeNull()
  })

  test('nothing is pre-filled: an untouched form is NEUTRAL with every limit empty', () => {
    render(<PrepPage />)
    expect(screen.getByTestId('plan-bias').textContent).toMatch(/NEUTRAL/)
    expect((screen.getByLabelText('DAILY LOSS LIMIT ($)') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('MAX ATTEMPTS') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('SESSION PROFILE') as HTMLSelectElement).value).toBe('')
    expect(screen.getByTestId('check-RISK_LIMITS').textContent).toMatch(/Write the daily loss limit/)
  })

  test('an unreadable plan store is reported, saving is off, and the stored value is left alone', async () => {
    window.localStorage.setItem(PLAN_STORAGE_KEY, '{oops')
    render(<PrepPage />)
    expect((await screen.findByTestId('plan-error')).textContent).toMatch(/left untouched/)
    const save = screen.getByRole('button', { name: 'Save plan' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    expect(window.localStorage.getItem(PLAN_STORAGE_KEY)).toBe('{oops')
  })
})
