/**
 * Journal analytics by dimension. The floor is per bucket: a slice of a
 * journal is a smaller sample, and a rate over it is published only at
 * MIN_SAMPLE measured trades in that bucket alone.
 */
import { describe, expect, test } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MIN_SAMPLE, createEntry, journalStats, type Exit, type JournalEntry } from '@/lib/journal'
import { journalBreakdown } from '@/lib/journalBreakdown'
import { evaluateTicket, minutesOf, ticketRecord, visibleGates, type TicketInput } from '@/lib/tradeTicket'
import { STORAGE_KEY, serializeJournal } from '@/lib/journalStore'
import JournalPage from '@/app/journal/page'
import { vi } from 'vitest'

vi.mock('@/lib/marketSession', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/marketSession')>()
  return { ...orig, useMarketSession: () => ({ panel: { status: 'loading' }, sources: { status: 'loading' } }) }
})

const SPEC = { tickSize: 0.25, tickValue: 12.5, unit: 'contract' as const }
const SAVED = '2026-11-09T15:00:00.000Z'

function ticket(o: Partial<TicketInput> = {}) {
  const base: Omit<TicketInput, 'answers'> = {
    symbol: 'ES', spec: { ...SPEC, micro: 'MES' }, contract: 'ESZ6', side: 'LONG', setupId: 'x',
    model: 'TRAP_FADE', sessionProfile: 'ONEPAGER', alsoRequire: { candle23: false, cisd: false },
    narrative: { htfContext: 'a', poi: 'b', liquidityEvent: 'c', invalidation: 'd', cancelCondition: 'e', managementPlan: 'f', screenshot: 'g' },
    entry: 5000, stop: 4990, targets: [{ price: 5030, kind: 'EXTERNAL' }],
    riskBudget: 2000, costPerUnit: 5, slippageTicks: 1, minR: 2,
    clock: { state: 'OPEN', nowMinutesEt: minutesOf('10:00'), closeMinutesEt: minutesOf('16:00') },
    plan: { status: 'WRITTEN', date: '2026-11-09', missing: [], lossLimit: null, maxAttempts: null, windows: [], day: null },
    ...o,
  }
  const answers: TicketInput['answers'] = {}
  for (const { def } of visibleGates({ ...base, answers: {} })) answers[def.id] = 'PASS'
  const input = { ...base, answers }
  return ticketRecord(input, evaluateTicket(input), SAVED, 'UNVERIFIED')
}

let seq = 0
function closed(exitPrice: number, o: Partial<TicketInput> = {}, extra: Partial<JournalEntry> = {}): JournalEntry {
  seq++
  const made = createEntry(ticket({ setupId: `S-${seq}`, ...o }), SPEC, SAVED, `e${seq}`)
  if ('error' in made) throw new Error(made.error)
  const exits: Exit[] = [{ price: exitPrice, units: 1, at: '2026-11-09T16:00:00.000Z' }]
  return { ...made.entry, status: 'CLOSED', fill: { price: 5000, units: 1, at: '2026-11-09T15:05:00.000Z' }, exits, fees: 5, reviewed: true, ...extra }
}

describe('journalBreakdown', () => {
  test('buckets by model, NONE for a missing one, and sums to the whole-journal sample', () => {
    const es = [closed(5030), closed(4990), closed(5030, { model: null as never })]
    const b = journalBreakdown(es, 'model')
    expect(b.buckets.map((x) => [x.key, x.measured])).toEqual([['TRAP_FADE', 2], ['NONE', 1]])
    expect(b.measured).toBe(journalStats(es).measured)
    expect(b.buckets.reduce((a, x) => a + x.measured, 0)).toBe(b.measured)
    const tf = b.buckets[0]
    expect([tf.wins, tf.losses]).toEqual([1, 1])
  })

  test('no rate below the floor in a bucket, even when the journal as a whole is past it', () => {
    const es = [
      ...Array.from({ length: MIN_SAMPLE }, () => closed(5030)),
      ...Array.from({ length: MIN_SAMPLE - 1 }, () => closed(4990, { symbol: 'MES' as never, spec: { ...SPEC, micro: null } as never, contract: 'MESZ6' })),
    ]
    const b = journalBreakdown(es, 'symbol')
    const byKey = Object.fromEntries(b.buckets.map((x) => [x.key, x]))
    expect(byKey.ES.measured).toBe(MIN_SAMPLE)
    expect(byKey.ES.rates?.winRate).toBe(1)
    expect(byKey.MES.measured).toBe(MIN_SAMPLE - 1)
    expect(byKey.MES.rates).toBeNull()
    expect(journalStats(es).rates).not.toBeNull()
  })

  test('open, passed and unmeasured entries are not counted', () => {
    const open = { ...closed(5030), status: 'TAKEN' as const, exits: [] }
    const passed = { ...closed(5030), status: 'PASSED' as const }
    const noFill = { ...closed(5030), fill: null }
    const takenWithExits = { ...closed(5030), status: 'TAKEN' as const }
    expect(journalBreakdown([open, passed, noFill, takenWithExits], 'model').measured).toBe(0)
  })

  test('a closed trade with P&L but no R (filled at the stop) is not in the sample', () => {
    const atStop = { ...closed(5030), fill: { price: 4990, units: 1, at: '2026-11-09T15:05:00.000Z' } }
    expect(journalStats([atStop]).measured).toBe(0)
    expect(journalBreakdown([atStop], 'model').measured).toBe(0)
  })

  test('tags overlap: one trade in several buckets, untagged in its own', () => {
    const a = closed(5030, {}, { tags: ['CHASE', 'TILT'] as never })
    const b = closed(4990)
    const r = journalBreakdown([a, b], 'tag')
    expect(r.overlapping).toBe(true)
    const keys = r.buckets.map((x) => x.key).sort()
    expect(keys).toEqual(['CHASE', 'TILT', 'UNTAGGED'].sort())
    expect(r.buckets.reduce((s, x) => s + x.measured, 0)).toBeGreaterThan(r.measured)
  })

  test('process buckets reflect the grade', () => {
    const r = journalBreakdown([closed(5030), closed(5030, {}, { reviewed: false })], 'process')
    expect(r.buckets.map((x) => x.key).sort()).toEqual(['CLEAN', 'UNREVIEWED'])
  })
})

describe('the journal page breakdown', () => {
  test('renders counts and the per-bucket floor, never a rate below it', () => {
    window.localStorage.clear()
    window.localStorage.setItem(STORAGE_KEY, serializeJournal([closed(5030), closed(4990)], []))
    render(<JournalPage />)
    const panel = screen.getByTestId('journal-breakdown')
    const rows = within(panel).getAllByTestId('breakdown-row')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain(`2 of ${MIN_SAMPLE}`)
    expect(rows[0].textContent).not.toMatch(/%/)
    fireEvent.change(within(panel).getByLabelText('SPLIT BY'), { target: { value: 'tag' } })
    expect(within(panel).getByText(/overlap/)).toBeTruthy()
  })

  test('the page reads the breakdown module, not its own arithmetic', () => {
    const src = readFileSync(join(__dirname, '..', 'app', 'journal', 'page.tsx'), 'utf8')
    expect(src).toContain('journalBreakdown(entries, dim)')
    expect(src).not.toMatch(/wins\s*\/\s*x\.measured/)
  })
})
