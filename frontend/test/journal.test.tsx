/**
 * The trade journal, and the two ticket gates it can tighten.
 *
 * The base trade: ES long, entry 5000, stop 4990 (40 ticks), 1 tick of stop
 * slippage and $5 round trip: (40 + 1) × 12.50 + 5 = $517.50 a contract. A
 * $2,000 budget buys 3. Target 5030 nets 2.89R, so the ticket is approved.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import {
  MIN_SAMPLE, createEntry, etDate, evaluateEntry, isEntry, journalStats, priorAttempts, realizedOf, stopOutsOn,
  type Exit, type JournalEntry,
} from '@/lib/journal'
import { STORAGE_KEY, mergeImport, parseJournal, serializeJournal } from '@/lib/journalStore'
import {
  evaluateTicket, minutesOf, ticketRecord, visibleGates,
  type TicketInput, type TicketRecord,
} from '@/lib/tradeTicket'
import type { MarketSession } from '@/lib/marketSession'
import JournalPage from '@/app/journal/page'
import TicketPage from '@/app/ticket/page'

const CLOCK = vi.hoisted(() => ({
  session: {
    state: 'OPEN', date: '2026-11-09', nowMinutesEt: 600, openMinutesEt: 570, closeMinutesEt: 960,
    basis: 'test', source: 'test', readAt: '2026-11-06', coverage: { from: '2026-01-01', to: '2027-12-31' },
  } as unknown,
}))

vi.mock('@/lib/marketSession', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/marketSession')>()
  return { ...orig, useMarketSession: () => ({ panel: { status: 'ok', data: CLOCK.session as MarketSession }, sources: { status: 'loading' } }) }
})

const SPEC = { tickSize: 0.25, tickValue: 12.5, unit: 'contract' as const }
const SAVED = '2026-11-09T15:00:00.000Z'

function ticketInput(o: Partial<TicketInput> = {}): TicketInput {
  const base: Omit<TicketInput, 'answers'> = {
    symbol: 'ES', spec: { ...SPEC, micro: 'MES' }, contract: 'ESZ6', side: 'LONG', setupId: 'ES-1109-01',
    model: 'TRAP_FADE', sessionProfile: 'ONEPAGER', alsoRequire: { candle23: false, cisd: false },
    narrative: { htfContext: 'a', poi: 'b', liquidityEvent: 'c', invalidation: 'd', cancelCondition: 'e', managementPlan: 'f', screenshot: 'g' },
    entry: 5000, stop: 4990, targets: [{ price: 5030, kind: 'EXTERNAL' }],
    riskBudget: 2000, costPerUnit: 5, slippageTicks: 1, minR: 2,
    clock: { state: 'OPEN', nowMinutesEt: minutesOf('10:00'), closeMinutesEt: minutesOf('16:00') },
    ...o,
  }
  const answers: TicketInput['answers'] = {}
  for (const { def } of visibleGates({ ...base, answers: {} })) answers[def.id] = 'PASS'
  return { ...base, answers: o.answers ?? answers }
}

function ticket(o: Partial<TicketInput> = {}): TicketRecord {
  const input = ticketInput(o)
  return ticketRecord(input, evaluateTicket(input), SAVED, 'UNVERIFIED')
}

function entry(o: Partial<JournalEntry> = {}, t: TicketRecord = ticket(), id = 'e1'): JournalEntry {
  const made = createEntry(t, SPEC, o.savedAt ?? SAVED, id)
  if ('error' in made) throw new Error(made.error)
  return { ...made.entry, ...o }
}

const exit = (price: number, units: number, at = '2026-11-09T16:00:00.000Z'): Exit => ({ price, units, at })
const fill = (price: number, units: number, at = '2026-11-09T15:05:00.000Z') => ({ price, units, at })

function closed(price: number, exits: Exit[], fees: number | null = 10, o: Partial<JournalEntry> = {}, t?: TicketRecord, id?: string) {
  const units = exits.reduce((a, x) => a + x.units, 0)
  return entry({ status: 'CLOSED', fill: fill(price, units), exits, fees, ...o }, t, id)
}

beforeEach(() => window.localStorage.clear())

describe('the base ticket', () => {
  test('is approved at 3 contracts', () => {
    const t = ticket()
    expect(t.state).toBe('APPROVED_TRADE')
    expect(t.plan.units).toBe(3)
    expect(t.plan.lossPerUnit).toBeCloseTo(517.5, 9)
  })
})

describe('R is measured from the fill, against the planned stop', () => {
  test('a fill at the planned entry', () => {
    // 120 ticks × 12.50 × 2 = 3,000 − 10 fees = 2,990 on 2 × 517.50 = 1,035 at risk.
    const { realized, problems } = realizedOf(closed(5000, [exit(5030, 2)]))
    expect(problems).toEqual([])
    expect(realized?.pnl).toBeCloseTo(2990, 9)
    expect(realized?.riskAtFill).toBeCloseTo(1035, 9)
    expect(realized?.r).toBeCloseTo(2990 / 1035, 12)
  })

  test('a worse fill carries more risk to the same stop', () => {
    // 5001 to 4990 is 44 ticks: (44 + 1) × 12.50 + 5 = 567.50 a contract.
    // 5001 to 5030 is 116 ticks: 116 × 12.50 × 2 = 2,900 − 10 = 2,890.
    const { realized } = realizedOf(closed(5001, [exit(5030, 2)]))
    expect(realized?.riskAtFill).toBeCloseTo(2 * 567.5, 9)
    expect(realized?.r).toBeCloseTo(2890 / 1135, 12)
  })

  test('a short is measured the other way up', () => {
    const t = ticket({ side: 'SHORT', stop: 5010, targets: [{ price: 4970, kind: 'EXTERNAL' }] })
    const { realized } = realizedOf(closed(5000, [exit(4970, 1)], 0, {}, t))
    expect(realized?.pnl).toBeCloseTo(120 * 12.5, 9)
    expect(realized?.r).toBeCloseTo(1500 / 517.5, 12)
  })

  test('partial exits are summed at their own prices', () => {
    const { realized } = realizedOf(closed(5000, [exit(5010, 1), exit(5030, 1)], 0))
    expect(realized?.pnl).toBeCloseTo(40 * 12.5 + 120 * 12.5, 9)
  })

  test('exits that do not cover every unit are not a result', () => {
    const e = entry({ status: 'CLOSED', fill: fill(5000, 2), exits: [exit(5030, 1)], fees: 10 })
    const { realized, problems } = realizedOf(e)
    expect(realized).toBeNull()
    expect(problems.join(' ')).toMatch(/Exits account for 1 of 2/)
  })

  test('a missing fee is not a zero fee', () => {
    const { realized, problems } = realizedOf(closed(5000, [exit(5030, 1)], null))
    expect(realized).toBeNull()
    expect(problems.join(' ')).toMatch(/missing fee is not a zero fee/)
  })

  test('a fill through the planned stop has P&L but no R', () => {
    const { realized, problems } = realizedOf(closed(4989, [exit(4980, 1)], 0))
    expect(realized?.pnl).toBeCloseTo(-36 * 12.5, 9)
    expect(realized?.r).toBeNull()
    expect(problems.join(' ')).toMatch(/through the planned stop/)
  })

  test('outcome is the sign of net P&L', () => {
    expect(evaluateEntry(closed(5000, [exit(4995, 1)]), []).outcome).toBe('LOSS')
    expect(evaluateEntry(closed(5000, [exit(5030, 1)]), []).outcome).toBe('WIN')
    expect(evaluateEntry(closed(5000, [exit(5000, 1)], 0), []).outcome).toBe('BREAKEVEN')
  })
})

describe('violations the data shows are tagged without being asked', () => {
  test('taking a blocked ticket', () => {
    const t = ticket({ answers: { ...ticketInput().answers, retest: 'FAIL' } })
    expect(t.state).toBe('BLOCKED')
    expect(evaluateEntry(closed(5000, [exit(5030, 1)], 0, {}, t), []).autoTags).toContain('TOOK_BLOCKED_TICKET')
  })

  test('more units than planned', () => {
    expect(evaluateEntry(closed(5000, [exit(5030, 4)]), []).autoTags).toContain('OVERSIZED')
    expect(evaluateEntry(closed(5000, [exit(5030, 3)]), []).autoTags).not.toContain('OVERSIZED')
  })

  test('a stop moved further away is widened; moved closer is not', () => {
    expect(evaluateEntry(closed(5000, [exit(5030, 1)], 0, { actualStop: 4985 }), []).autoTags).toContain('WIDENED_STOP')
    expect(evaluateEntry(closed(5000, [exit(5030, 1)], 0, { actualStop: 4995 }), []).autoTags).not.toContain('WIDENED_STOP')
    const short = ticket({ side: 'SHORT', stop: 5010, targets: [{ price: 4970, kind: 'EXTERNAL' }] })
    expect(evaluateEntry(closed(5000, [exit(4970, 1)], 0, { actualStop: 5015 }, short), []).autoTags).toContain('WIDENED_STOP')
  })

  test('a second attempt at the same idea is tagged on the later fill only', () => {
    const first = closed(5000, [exit(4995, 1)], 0, { fill: fill(5000, 1, '2026-11-09T15:05:00.000Z') }, undefined, 'a')
    const second = closed(5000, [exit(5030, 1)], 0, { fill: fill(5000, 1, '2026-11-09T15:40:00.000Z') }, ticket({ setupId: 'es-1109-01 ' }), 'b')
    const all = [first, second]
    expect(evaluateEntry(first, all).autoTags).not.toContain('SECOND_ATTEMPT')
    expect(evaluateEntry(second, all).autoTags).toContain('SECOND_ATTEMPT')
  })
})

describe('process is judged apart from outcome', () => {
  test('clean needs a review and no tags', () => {
    expect(evaluateEntry(closed(5000, [exit(4995, 1)], 0), []).process).toBe('UNREVIEWED')
    expect(evaluateEntry(closed(5000, [exit(4995, 1)], 0, { reviewed: true }), []).process).toBe('CLEAN')
  })

  test('a self-reported tag is a violation, and so is a measured one even when reviewed', () => {
    expect(evaluateEntry(closed(5000, [exit(5030, 1)], 0, { reviewed: true, tags: ['CHASE'] }), []).process).toBe('VIOLATION')
    expect(evaluateEntry(closed(5000, [exit(5030, 4)], 0, { reviewed: true }), []).process).toBe('VIOLATION')
  })

  test('a clean loss stays clean', () => {
    const ev = evaluateEntry(closed(5000, [exit(4990, 1)], 0, { reviewed: true }), [])
    expect(ev.outcome).toBe('LOSS')
    expect(ev.process).toBe('CLEAN')
  })
})

describe('no rate below the sample floor', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) =>
    closed(5000, [exit(i % 2 ? 5030 : 4995, 1)], 0, { reviewed: true }, ticket({ setupId: `S-${i}` }), `id-${i}`))

  test(`${MIN_SAMPLE - 1} measured trades publish counts and total R, and no rate`, () => {
    const s = journalStats(many(MIN_SAMPLE - 1))
    expect(s.measured).toBe(MIN_SAMPLE - 1)
    expect(s.rates).toBeNull()
    expect(s.wins + s.losses + s.breakeven).toBe(MIN_SAMPLE - 1)
  })

  test(`${MIN_SAMPLE} measured trades publish a win rate and average R`, () => {
    const s = journalStats(many(MIN_SAMPLE))
    expect(s.rates?.winRate).toBeCloseTo(15 / 30, 12)
    expect(s.rates?.avgR).toBeCloseTo(s.totalR / 30, 12)
  })

  test('clean and violation trades are bucketed apart; planned and passed are not taken', () => {
    const s = journalStats([
      closed(5000, [exit(5030, 1)], 0, { reviewed: true }, ticket({ setupId: 'A' }), 'a'),
      closed(5000, [exit(5030, 1)], 0, { reviewed: true, tags: ['REVENGE'] }, ticket({ setupId: 'B' }), 'b'),
      entry({}, ticket({ setupId: 'C' }), 'c'),
      entry({ status: 'PASSED' }, ticket({ setupId: 'D' }), 'd'),
    ])
    expect(s.byProcess.clean.n).toBe(1)
    expect(s.byProcess.violation.n).toBe(1)
    expect(s.taken).toBe(2)
    expect(s.passed).toBe(1)
    expect(s.tagCounts.REVENGE).toBe(1)
  })
})

describe('what the journal tells the ticket', () => {
  test('earlier taken attempts are counted by setup ID, case and spaces aside', () => {
    const es = [
      entry({ status: 'TAKEN', fill: fill(5000, 1) }, ticket(), 'a'),
      entry({ status: 'PLANNED' }, ticket(), 'b'),
      entry({ status: 'PASSED' }, ticket(), 'c'),
    ]
    expect(priorAttempts(es, ' es-1109-01')).toBe(1)
    expect(priorAttempts(es, 'OTHER')).toBe(0)
  })

  test('stop-outs are counted on the ET date of the last exit', () => {
    // 03:30Z on the 10th is 22:30 ET on the 9th.
    const late = '2026-11-10T03:30:00.000Z'
    expect(etDate(late)).toBe('2026-11-09')
    const es = [
      closed(5000, [exit(4995, 1, late)], 0, {}, ticket({ setupId: 'A' }), 'a'),
      closed(5000, [exit(4995, 1, late)], null, {}, ticket({ setupId: 'B' }), 'b'),   // no fees yet, lost before fees
      closed(5000, [exit(5030, 1, late)], 0, {}, ticket({ setupId: 'C' }), 'c'),
    ]
    expect(stopOutsOn(es, '2026-11-09')).toBe(2)
    expect(stopOutsOn(es, '2026-11-10')).toBe(0)
  })

  test('an earlier attempt blocks the ticket even when answered PASS', () => {
    const r = evaluateTicket({ ...ticketInput(), journal: { priorAttempts: 1, stopOutsToday: 0 } })
    expect(r.state).toBe('BLOCKED')
    expect(r.blockers.map((b) => b.code)).toEqual(['ONE_ATTEMPT_ALREADY_USED'])
    expect(r.gates.find((g) => g.id === 'firstAttempt')?.source).toBe('COMPUTED')
  })

  test('two stop-outs today lock the day, even before a direction is chosen', () => {
    expect(evaluateTicket({ ...ticketInput(), journal: { priorAttempts: 0, stopOutsToday: 2 } }).blockers.map((b) => b.code)).toEqual(['DAILY_LOCK_ACTIVE'])
    expect(evaluateTicket({ ...ticketInput({ side: null }), journal: { priorAttempts: 0, stopOutsToday: 2 } }).state).toBe('BLOCKED')
    expect(evaluateTicket({ ...ticketInput(), journal: { priorAttempts: 0, stopOutsToday: 1 } }).state).toBe('APPROVED_TRADE')
  })

  test('an empty journal cannot loosen a gate the trader failed', () => {
    const r = evaluateTicket({ ...ticketInput({ answers: { ...ticketInput().answers, firstAttempt: 'FAIL' } }), journal: { priorAttempts: 0, stopOutsToday: 0 } })
    expect(r.blockers.map((b) => b.code)).toEqual(['ONE_ATTEMPT_ALREADY_USED'])
    expect(r.gates.find((g) => g.id === 'firstAttempt')?.source).toBe('TRADER')
  })
})

describe('creating, storing and importing', () => {
  test('a NEUTRAL ticket or one with no setup ID is not journaled', () => {
    expect(createEntry(ticket({ side: null }), SPEC, SAVED)).toHaveProperty('error')
    expect(createEntry(ticket({ setupId: '' }), SPEC, SAVED)).toHaveProperty('error')
  })

  test('an unreadable store is reported and not treated as empty', () => {
    expect(parseJournal('{oops').error).toMatch(/could not be read/)
    expect(parseJournal('{"a":1}').error).toMatch(/not a list/)
    expect(parseJournal(null)).toEqual({ entries: [], rejected: [], error: null })
  })

  test('an entry that fails the shape check is counted and kept on save', () => {
    const bad = { ...entry(), fees: '10' }
    const p = parseJournal(JSON.stringify([entry(), bad]))
    expect(p.entries).toHaveLength(1)
    expect(p.rejected).toHaveLength(1)
    expect(isEntry(bad)).toBe(false)
    expect(JSON.parse(serializeJournal(p.entries, p.rejected))).toHaveLength(2)
  })

  test('an import adds by id and never rewrites an existing entry', () => {
    const mine = entry({ emotion: 'mine' }, ticket(), 'same')
    const theirs = entry({ emotion: 'theirs' }, ticket(), 'same')
    const fresh = entry({}, ticket({ setupId: 'NEW' }), 'new')
    const r = mergeImport([mine], JSON.stringify([theirs, fresh]))
    if ('error' in r) throw new Error(r.error)
    expect(r.added).toBe(1)
    expect(r.skipped).toBe(1)
    expect(r.entries.find((e) => e.id === 'same')?.emotion).toBe('mine')
    expect(mergeImport([], 'nope')).toHaveProperty('error')
  })
})

describe('the pages', () => {
  test('the journal says where it is stored, and withholds a rate below the floor', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([closed(5000, [exit(5030, 2)])]))
    render(<JournalPage />)
    expect(screen.getByTestId('storage-note').textContent).toMatch(/this browser only/)
    expect((await screen.findByTestId('entry-result')).textContent).toMatch(/\+2\.89R/)
    expect(screen.getByTestId('entry-process').textContent).toBe('PROCESS UNREVIEWED')
    expect(screen.getByTestId('journal-rates').textContent).toMatch(new RegExp(`1 of ${MIN_SAMPLE} measured trades`))
  })

  test('an unreadable journal is not overwritten by an import', async () => {
    window.localStorage.setItem(STORAGE_KEY, '{oops')
    render(<JournalPage />)
    expect((await screen.findByTestId('journal-error')).textContent).toMatch(/left untouched/)
    fireEvent.change(screen.getByLabelText('IMPORT (PASTE AN EXPORT)'), { target: { value: JSON.stringify([entry()]) } })
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('{oops')
  })

  test('a ticket saved from the ticket page, then taken, blocks the same idea next time', async () => {
    const view = render(<TicketPage />)
    fireEvent.change(screen.getByLabelText('INSTRUMENT'), { target: { value: 'ES' } })
    fireEvent.click(screen.getByRole('button', { name: 'LONG' }))
    fireEvent.change(screen.getByLabelText('SETUP / IDEA ID'), { target: { value: 'ES-1109-02' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save to journal' }))
    expect(screen.getByTestId('save-msg').textContent).toMatch(/Saved to the journal as ES-1109-02/)
    const stored = parseJournal(window.localStorage.getItem(STORAGE_KEY))
    expect(stored.entries).toHaveLength(1)
    expect(stored.entries[0]!.status).toBe('PLANNED')
    view.unmount()

    // Mark it taken, as the journal page would, and open a new ticket for the same idea.
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([{ ...stored.entries[0]!, status: 'TAKEN', fill: fill(5000, 1) }]))
    render(<TicketPage />)
    fireEvent.change(screen.getByLabelText('INSTRUMENT'), { target: { value: 'ES' } })
    fireEvent.click(screen.getByRole('button', { name: 'LONG' }))
    fireEvent.change(screen.getByLabelText('SETUP / IDEA ID'), { target: { value: 'es-1109-02' } })
    expect(screen.getByTestId('ticket-state').textContent).toBe('BLOCKED')
    expect(screen.getByTestId('blockers').textContent).toMatch(/ONE_ATTEMPT_ALREADY_USED/)
  })
})
