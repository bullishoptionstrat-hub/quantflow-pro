/**
 * The desk overview: every panel says where its numbers come from, and says
 * plainly when it has none. Each panel is checked empty and populated, with
 * the plan and journal built through the app's own functions.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MarketSession, SessionPoll } from '@/lib/marketSession'
import { PLAN_STORAGE_KEY } from '@/lib/dailyPlanStore'
import { STORAGE_KEY as JOURNAL_KEY } from '@/lib/journalStore'
import { createEntry, type Exit, type JournalEntry } from '@/lib/journal'
import { deskLock, latestTicket, minutesText } from '@/lib/desk'
import { evaluateTicket, minutesOf, ticketRecord, visibleGates, type PlanContext, type TicketInput } from '@/lib/tradeTicket'
import type { GEXLevel, GEXResponse } from '@/lib/types'
import { completePlan } from './planFixtures'

const DATE = '2026-11-09'

const SESSION = vi.hoisted(() => ({ value: null as unknown }))
vi.mock('@/lib/marketSession', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/marketSession')>()
  return { ...orig, useMarketSession: () => SESSION.value as SessionPoll }
})
const GEX = vi.hoisted(() => ({ bySymbol: {} as Record<string, unknown> }))
vi.mock('@/lib/apiFetch', () => ({
  apiFetch: vi.fn(async (path: string) => {
    const sym = /symbol=(\w+)/.exec(path)?.[1] ?? ''
    const body = GEX.bySymbol[sym]
    if (body === undefined) return { ok: false, status: 503, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => body }
  }),
}))

import DeskPage from '@/app/desk/page'

const session = (hhmm: string, o: Partial<MarketSession> = {}): MarketSession => ({
  state: 'OPEN', date: DATE, nowMinutesEt: minutesOf(hhmm), openMinutesEt: 570, closeMinutesEt: 960,
  basis: '2026-11-09 is a regular session', source: 'test', readAt: '2026-11-06', coverage: { from: '2026-01-01', to: '2027-12-31' }, ...o,
})
const poll = (s: MarketSession | null): SessionPoll => ({
  panel: s === null ? { status: 'unreachable' } : { status: 'ok', data: s },
  sources: s === null ? { status: 'unreachable' } : { status: 'ok', data: {
    byState: { connected: ['cboe', 'fred'], degraded: [], error: ['polygon'], refused: ['yahoo'], disabled: ['tradier'], unknown: [] },
    simulation: true,
  } },
})

// ─── Fixtures through the app's own functions ──────────────────────────────

const SPEC = { tickSize: 0.25, tickValue: 12.5, unit: 'contract' as const }
function record(o: Partial<TicketInput> = {}) {
  const base: Omit<TicketInput, 'answers'> = {
    symbol: 'ES', spec: { ...SPEC, micro: 'MES' }, contract: 'ESZ6', side: 'LONG', setupId: 'ES-1109-01',
    model: 'TRAP_FADE', sessionProfile: 'ONEPAGER', alsoRequire: { candle23: false, cisd: false },
    narrative: { htfContext: 'a', poi: 'b', liquidityEvent: 'c', invalidation: 'd', cancelCondition: 'e', managementPlan: 'f', screenshot: 'g' },
    entry: 5000, stop: 4990, targets: [{ price: 5030, kind: 'EXTERNAL' }], riskBudget: 1000, costPerUnit: 0, slippageTicks: 0, minR: 2,
    clock: { state: 'OPEN', nowMinutesEt: 600, closeMinutesEt: 960 },
    plan: { status: 'WRITTEN', date: DATE, missing: [], lossLimit: 500, maxAttempts: 2, windows: [], day: null },
    ...o,
  }
  const answers: TicketInput['answers'] = {}
  for (const { def } of visibleGates({ ...base, answers: {} })) answers[def.id] = 'PASS'
  const input = { ...base, answers: o.answers ?? answers }
  return ticketRecord(input, evaluateTicket(input), `${DATE}T14:00:00.000Z`, 'UNVERIFIED')
}
function entry(id: string, savedAt: string, o: Partial<JournalEntry> = {}, t = record({ setupId: id })): JournalEntry {
  const made = createEntry(t, SPEC, savedAt, id)
  if ('error' in made) throw new Error(made.error)
  return { ...made.entry, ...o }
}
const exit = (price: number, at = `${DATE}T16:00:00.000Z`): Exit => ({ price, units: 1, at })
const closed = (id: string, exitPrice: number, fees: number | null, savedAt = `${DATE}T14:00:00.000Z`) =>
  entry(id, savedAt, { status: 'CLOSED', fill: { price: 5000, units: 1, at: `${DATE}T15:05:00.000Z` }, exits: [exit(exitPrice)], fees })

const lvl = (strike: number, callOI: number, putOI: number): GEXLevel => ({
  strike, gex: 0, dex: 0, dexMissing: 0, callOI, putOI, callGamma: 0, putGamma: 0, callDelta: 0, putDelta: 0,
})
const chain = (symbol: string, o: Partial<GEXResponse> = {}): GEXResponse => ({
  symbol, levels: [lvl(670, 9_000, 1_000), lvl(680, 25_000, 2_000), lvl(660, 3_000, 31_000)], zeroDte: null, flipStrike: null,
  keyLevels: { gex: { maxStrike: null, max: null, minStrike: null, min: null }, dex: { maxStrike: null, max: null, minStrike: null, min: null }, totalGex: -5, totalDex: 1 },
  updatedAt: '2026-11-09T15:10:00.000Z', source: 'cboe', realData: true, realtime: false, delayedMinutes: 15,
  asOf: '2026-11-09T14:55:00.000Z', spot: 671.5, spotField: 'current_price',
  ...o,
})

const store = (plans: unknown[], entries: unknown[]) => {
  window.localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify(plans))
  window.localStorage.setItem(JOURNAL_KEY, JSON.stringify(entries))
}

beforeEach(() => {
  window.localStorage.clear()
  GEX.bySymbol = {}
  SESSION.value = poll(session('10:00'))
})

// ─── Empty ─────────────────────────────────────────────────────────────────

describe('empty states', () => {
  test('a fresh browser: no plan, no journal, no chain — each panel says which', async () => {
    render(<DeskPage />)
    await waitFor(() => expect(screen.getByTestId('desk-gex-SPY').textContent).toMatch(/did not answer/))
    expect(screen.getByTestId('desk-session-label').textContent).toBe('RTH OPEN')
    expect(screen.getByTestId('desk-date').textContent).toMatch(/2026-11-09/)
    expect(screen.getByTestId('desk-clock').textContent).toMatch(/10:00 ET/)
    expect(screen.getByTestId('desk-plan-empty').textContent).toMatch(/No plan written for 2026-11-09/)
    expect(screen.getByTestId('desk-next-event').textContent).toMatch(/No plan, so no declared events/)
    expect(screen.getByTestId('desk-lock').textContent).toBe('UNKNOWN')
    expect(screen.getByTestId('desk-lock-reasons').textContent).toMatch(/No plan is written for 2026-11-09/)
    expect(screen.getByTestId('desk-pnl').textContent).toMatch(/no trade closed/)
    expect(screen.getByTestId('desk-r').textContent).toMatch(/—/)
    expect(screen.getByTestId('desk-stopouts').textContent).toMatch(/0 \/ 2/)
    expect(screen.getByTestId('desk-attempts').textContent).toMatch(/0 \/ max not written/)
    expect(screen.getByTestId('desk-ticket-empty')).toBeTruthy()
    expect(screen.getByTestId('desk-gex-QQQ').textContent).toMatch(/did not answer/)
    expect(screen.getByTestId('desk-sources').textContent).toMatch(/2 CONNECTED/)
  })

  test('no backend answer: the date is unknown and no figure for today is shown', async () => {
    SESSION.value = poll(null)
    render(<DeskPage />)
    expect(screen.getByTestId('desk-session-label').textContent).toBe('SESSION UNKNOWN')
    expect(screen.getByTestId('desk-date').textContent).toMatch(/unknown/)
    expect(screen.getByTestId('desk-lock').textContent).toBe('UNKNOWN')
    expect(screen.getByTestId('desk-lock-reasons').textContent).toMatch(/date is unknown/)
    expect(screen.getByTestId('desk-plan-empty').textContent).toMatch(/date is unknown/)
    expect(screen.queryByTestId('desk-pnl')).toBeNull()
    expect(screen.getByTestId('desk-sources').textContent).toMatch(/did not answer/)
    await waitFor(() => expect(screen.getByTestId('desk-gex-SPY').textContent).toMatch(/did not answer/))
  })

  test('a chain the backend does not have is an honest empty state', async () => {
    GEX.bySymbol = { SPY: chain('SPY', { realData: false, levels: [], unavailableReason: 'No Cboe chain received yet.' }) }
    render(<DeskPage />)
    expect((await screen.findByTestId('desk-gex-SPY-empty')).textContent).toMatch(/No Cboe chain received yet/)
  })
})

// ─── Populated ─────────────────────────────────────────────────────────────

describe('populated', () => {
  test('a planned morning: plan, countdown, clear lock, latest ticket, GEX', async () => {
    GEX.bySymbol = { SPY: chain('SPY'), QQQ: chain('QQQ', { realData: false, levels: [], unavailableReason: 'none' }) }
    SESSION.value = poll(session('08:00'))
    store([completePlan(DATE)], [closed('a', 5002, 5, `${DATE}T14:00:00.000Z`)])
    render(<DeskPage />)

    await waitFor(() => expect(screen.getByTestId('desk-plan-bias').textContent).toBe('BULLISH'))
    expect(screen.getByTestId('desk-plan-checklist').textContent).toBe('CHECKLIST 6/6 COMPLETE')
    expect(screen.getByTestId('desk-scenario-primary').textContent).toMatch(/IF London low is swept and reclaimed/)
    expect(screen.getByTestId('desk-scenario-noTrade').textContent).toMatch(/THEN Stand aside/)
    const levels = within(screen.getByTestId('desk-levels'))
    expect(levels.getByText('Prior day high')).toBeTruthy()
    expect(levels.getByText('premium')).toBeTruthy()       // 5030 against EQ 5000 of 4970–5030
    expect(levels.getByText('discount')).toBeTruthy()      // 4988

    expect(screen.getByTestId('desk-next-event').textContent).toMatch(/CPI 08:30 ET · aside from 08:25 · in 25 min/)

    expect(screen.getByTestId('desk-lock').textContent).toBe('CLEAR')
    expect(screen.getByTestId('desk-pnl').textContent).toMatch(/\$95\.00/)          // +2 points × $50 − $5 fees
    expect(screen.getByTestId('desk-r').textContent).toMatch(/\+0\.19R over 1/)    // $95 / $500 at risk (40 ticks × $12.50)
    expect(screen.getByTestId('desk-loss-bar').textContent).toMatch(/\$0\.00 \/ \$500\.00/)
    expect(screen.getByTestId('desk-attempts').textContent).toMatch(/1 \/ 2/)

    expect(screen.getByTestId('desk-ticket-state').textContent).toBe('APPROVED TRADE')
    expect(screen.getByTestId('desk-ticket').textContent).toMatch(/As saved/)

    await waitFor(() => expect(screen.getByTestId('desk-gex-SPY').textContent).toMatch(/680 · OI 25,000/))
    expect(screen.getByTestId('desk-gex-SPY').textContent).toMatch(/660 · OI 31,000/)
    expect(screen.getByTestId('desk-gex-SPY').textContent).toMatch(/NEGATIVE/)
    expect(screen.getByTestId('desk-gex-SPY-asof').textContent).toMatch(/AS OF 2026-11-09 09:55:00 ET.*DELAYED 15 MIN/)
    expect(screen.getByTestId('desk-gex').textContent).toMatch(/never a gate/)
    expect(screen.getByTestId('desk-gex-QQQ-empty')).toBeTruthy()
  })

  test('a profile window is called live only by the ticket\'s own session gate — never on a weekend morning', async () => {
    store([completePlan(DATE)], [])
    SESSION.value = poll(session('10:00'))
    const { unmount } = render(<DeskPage />)
    await waitFor(() => expect(screen.getByTestId('desk-window').textContent).toMatch(/^IN WINDOW · 10:00 ET is inside OnePager NY AM/))
    expect(screen.getByTestId('desk-session').textContent).toMatch(/NY AM 09:30–11:30 · NOW/)
    unmount()

    // 10:00 ET on a Saturday sits inside the NY AM clock window, and is not a session.
    SESSION.value = poll(session('10:00', { state: 'CLOSED_WEEKEND', basis: '2026-11-07 is a Saturday' }))
    render(<DeskPage />)
    await waitFor(() => expect(screen.getByTestId('desk-window').textContent).toMatch(/^OUTSIDE WINDOW · It is the weekend/))
    expect(screen.getByTestId('desk-session').textContent).not.toMatch(/· NOW/)
  })

  test('a losing day: the written limit is reached, the day is LOCKED, and a blocked ticket shows its codes', async () => {
    SESSION.value = poll(session('08:30'))
    store([completePlan(DATE)], [
      closed('a', 4995, 5, `${DATE}T13:00:00.000Z`),   // −5 points × $50 − $5 = −$255
      closed('b', 4995, 5, `${DATE}T13:30:00.000Z`),   // −$255
      // Saved last, and blocked on the trader's own state.
      entry('c', `${DATE}T14:30:00.000Z`, {}, record({ setupId: 'ES-1109-03', answers: { traderState: 'FAIL' } })),
    ])
    render(<DeskPage />)
    await waitFor(() => expect(screen.getByTestId('desk-lock').textContent).toBe('LOCKED'))
    const reasons = screen.getByTestId('desk-lock-reasons').textContent ?? ''
    expect(reasons).toMatch(/2 losing trades today/)
    expect(reasons).toMatch(/\$510\.00, which reaches the plan's written daily limit of \$500\.00/)
    expect(reasons).toMatch(/2 attempts taken on 2026-11-09, which uses the plan's maximum of 2/)
    expect(screen.getByTestId('desk-pnl').textContent).toMatch(/−\$510\.00/)
    expect(screen.getByRole('meter', { name: /Realized loss/ }).getAttribute('aria-valuenow')).toBe('100')
    expect(screen.getByTestId('desk-next-event').textContent).toMatch(/STAND ASIDE NOW · CPI until 08:45 ET/)
    expect(screen.getByTestId('desk-ticket-state').textContent).toBe('BLOCKED')
    expect(screen.getByTestId('desk-ticket-blockers').textContent).toMatch(/TRADER_STATE_NOT_CLEAR/)
  })
})

// ─── Rules ─────────────────────────────────────────────────────────────────

describe('what the desk may say', () => {
  const plan = (o: Partial<Extract<PlanContext, { status: 'WRITTEN' }>> = {}): PlanContext => ({
    status: 'WRITTEN', date: DATE, missing: [], lossLimit: 500, maxAttempts: 2, windows: [], day: { realizedLoss: 0, lossesWithoutFees: 0, attempts: 0 }, ...o,
  })

  test('CLEAR only when every limit is written and measured; LOCKED on the ticket\'s own reasons', () => {
    expect(deskLock(DATE, 0, plan()).state).toBe('CLEAR')
    expect(deskLock(DATE, 0, plan({ lossLimit: null })).state).toBe('UNKNOWN')
    expect(deskLock(DATE, 0, plan({ maxAttempts: null })).state).toBe('UNKNOWN')
    expect(deskLock(DATE, 0, plan({ day: null })).state).toBe('UNKNOWN')
    expect(deskLock(DATE, 0, { status: 'NOT_WRITTEN', date: DATE }).state).toBe('UNKNOWN')
    expect(deskLock(null, 0, plan()).state).toBe('UNKNOWN')
    expect(deskLock(DATE, null, plan()).state).toBe('UNKNOWN')
    expect(deskLock(DATE, 2, { status: 'NOT_WRITTEN', date: DATE }).state).toBe('LOCKED')
    expect(deskLock(DATE, 0, plan({ day: { realizedLoss: 500, lossesWithoutFees: 0, attempts: 0 } })).state).toBe('LOCKED')
    expect(deskLock(DATE, 0, plan({ day: { realizedLoss: 0, lossesWithoutFees: 0, attempts: 2 } })).state).toBe('LOCKED')
  })

  test('the latest ticket is the last one saved', () => {
    const es = [entry('a', `${DATE}T13:00:00.000Z`), entry('b', `${DATE}T15:00:00.000Z`), entry('c', `${DATE}T14:00:00.000Z`)]
    expect(latestTicket(es)?.id).toBe('b')
    expect(latestTicket([])).toBeNull()
  })

  test('countdowns are plain arithmetic', () => {
    expect(minutesText(0)).toBe('under 1 min')
    expect(minutesText(25)).toBe('25 min')
    expect(minutesText(125)).toBe('2 h 05 min')
  })

  test('the desk computes no lock of its own: it reads the ticket\'s reasons', () => {
    const src = readFileSync(join(__dirname, '..', 'lib', 'desk.ts'), 'utf8')
    expect(src).toMatch(/dailyLockReasons\(/)
    expect(src).not.toMatch(/realizedLoss\s*>=/)
  })

  test('the landing page is the desk, and the browser decides no weekday here', () => {
    expect(readFileSync(join(__dirname, '..', 'app', 'page.tsx'), 'utf8')).toMatch(/redirect\('\/desk'\)/)
    for (const f of ['app/desk/page.tsx', 'app/prep/page.tsx', 'lib/dailyPlan.ts', 'lib/desk.ts']) {
      const src = readFileSync(join(__dirname, '..', f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
      expect(src, f).not.toMatch(/getDay\(|getUTCDay\(|toLocaleDateString\(/)
    }
  })
})
