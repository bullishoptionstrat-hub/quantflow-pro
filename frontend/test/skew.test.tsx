/**
 * ROADMAP 5.5 — the skew table under the term structure.
 *
 * Hand-built payloads for the edge cases (a one-legged expiry, no chain, a
 * chain with no deltas at all); `backend/test/fixtures/vol.json` — the real
 * route, SPY, captured 2026-10-22 — for what a person actually sees.
 */
import { describe, expect, test } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VolResponse, SkewBlock } from '@/lib/types'

const FIX = join(__dirname, '..', '..', 'backend', 'test', 'fixtures')
const captured = (): VolResponse => JSON.parse(readFileSync(join(FIX, 'vol.json'), 'utf8'))

const SKEW_BASIS = 'Per expiry, the put and the call whose published |delta| is nearest 0.25.'

const skew = (points: SkewBlock['points']): SkewBlock =>
  ({ targetDelta: 0.25, ivUnits: 'FRACTION', basis: SKEW_BASIS, points })

const vol = (o: Partial<VolResponse> = {}): VolResponse => ({
  symbol: 'SPY', realData: true, unavailableReason: null, source: 'cboe',
  spot: 580, iv30: 18.34, tradeDate: '2026-09-24', asOf: '2026-09-24T15:45:00', delayedMinutes: 15,
  termStructure: {
    ivUnits: 'FRACTION', iv30Units: 'PERCENT',
    basis: 'Per expiry, the strike nearest spot that carries both a call and a put IV.',
    points: [
      { expiry: '2026-10-16', dte: 22, atmStrike: 580, distancePct: 0, callIv: 0.171, putIv: 0.189, atmIv: 0.18, ivMissing: 3, contracts: 200 },
    ],
  },
  skew: skew([
    { expiry: '2026-10-16', dte: 22,
      put: { strike: 560, delta: -0.31, iv: 0.221 }, call: { strike: 600, delta: 0.24, iv: 0.152 },
      riskReversal: 0.069, riskReversalPct: 6.9, ivMissing: 3, deltaMissing: 0, contracts: 200 },
    { expiry: '2026-12-18', dte: 85,
      put: { strike: 540, delta: -0.25, iv: 0.23 }, call: null,
      riskReversal: null, riskReversalPct: null, ivMissing: 0, deltaMissing: 40, contracts: 80 },
  ]),
  ivRank: null, ivPercentile: null, ivRankUnavailable: 'Not reported.',
  ...o,
})

describe('the skew table', () => {
  test('the header takes its delta from the payload, not from a constant', async () => {
    const { TermStructurePanel } = await import('@/components/gex/TermStructure')
    render(<TermStructurePanel panel={{ status: 'ok', data: vol() }} symbol="SPY" />)
    expect(screen.getByTestId('skew-header').textContent).toMatch(/25Δ RISK REVERSAL/)
    expect(screen.getByTestId('skew-basis').textContent).toContain(SKEW_BASIS)
  })

  test('each leg shows its strike, the delta actually chosen, and its IV as a percentage', async () => {
    const { TermStructurePanel } = await import('@/components/gex/TermStructure')
    render(<TermStructurePanel panel={{ status: 'ok', data: vol() }} symbol="SPY" />)
    const row = within(screen.getByTestId('skew-table')).getByText('2026-10-16').closest('tr')!
    // The put was the nearest row Cboe sent, at 0.31Δ — and the table says 0.31, not 0.25.
    expect(row.textContent).toContain('560')
    expect(row.textContent).toContain('-0.31Δ')
    expect(row.textContent).toContain('22.10%')
    expect(row.textContent).toContain('600')
    expect(row.textContent).toContain('+0.24Δ')
    expect(row.textContent).toContain('15.20%')
    expect(row.textContent).toContain('+6.90')
    expect(row.textContent).not.toContain('0.221')
  })

  test('an expiry with one leg shows dashes for the other and no risk reversal', async () => {
    const { TermStructurePanel } = await import('@/components/gex/TermStructure')
    render(<TermStructurePanel panel={{ status: 'ok', data: vol() }} symbol="SPY" />)
    const row = within(screen.getByTestId('skew-table')).getByText('2026-12-18').closest('tr')!
    expect(row.textContent).toContain('540')
    expect(row.textContent).toContain('-0.25Δ')
    const cells = Array.from(row.querySelectorAll('td')).map((td) => td.textContent)
    expect(cells[4]).toBe('—')   // call
    expect(cells[5]).toBe('—')   // call IV
    expect(cells[6]).toBe('—')   // risk reversal
    expect(cells[7]).toBe('40 / 80')
    expect(row.textContent).not.toMatch(/\b0\.00\b/)
  })

  test('a chain whose rows carried no deltas draws no skew table at all', async () => {
    const { TermStructurePanel } = await import('@/components/gex/TermStructure')
    render(<TermStructurePanel panel={{ status: 'ok', data: vol({
      skew: skew([{ expiry: '2026-10-16', dte: 22, put: null, call: null,
        riskReversal: null, riskReversalPct: null, ivMissing: 0, deltaMissing: 200, contracts: 200 }]),
    }) }} symbol="SPY" />)
    expect(screen.queryByTestId('skew-table')).toBeNull()
    expect(screen.queryByTestId('skew-header')).toBeNull()
    // The term structure above is unaffected.
    expect(screen.getByText('2026-10-16')).toBeDefined()
  })

  test('no chain means no skew and no claim about it', async () => {
    const { TermStructurePanel } = await import('@/components/gex/TermStructure')
    render(<TermStructurePanel panel={{ status: 'ok', data: vol({
      realData: false, source: null, termStructure: null, skew: null, iv30: null,
      unavailableReason: 'No Cboe chain has been received for SPY.',
    }) }} symbol="SPY" />)
    expect(screen.queryByTestId('skew-table')).toBeNull()
    expect(screen.getByText(/No Cboe chain has been received for SPY\./)).toBeDefined()
  })

  test('the captured chain renders one skew row per term-structure row, and every rr is put minus call', async () => {
    const { TermStructurePanel } = await import('@/components/gex/TermStructure')
    const data = captured()
    render(<TermStructurePanel panel={{ status: 'ok', data }} symbol={data.symbol} />)
    const table = screen.getByTestId('skew-table')
    const rows = table.querySelectorAll('tbody tr')
    expect(rows.length).toBe(data.skew!.points.length)
    expect(rows.length).toBe(data.termStructure!.points.length)
    for (const p of data.skew!.points) {
      if (!p.put || !p.call) continue
      const row = within(table).getByText(p.expiry).closest('tr')!
      const cells = Array.from(row.querySelectorAll('td')).map((td) => td.textContent!)
      const putIv = Number(cells[3].replace('%', ''))
      const callIv = Number(cells[5].replace('%', ''))
      const rr = Number(cells[6])
      // What is on screen agrees with itself to rounding: the row's rr is its
      // own two IV columns subtracted, not a number from somewhere else.
      expect(Math.abs(rr - (putIv - callIv))).toBeLessThan(0.011)
    }
  })

  test('formatters sign what they show and invent nothing for null', async () => {
    const { deltaText, rrText } = await import('@/components/gex/TermStructure')
    expect(deltaText(0.2495)).toBe('+0.25Δ')
    expect(deltaText(-0.2703)).toBe('-0.27Δ')
    expect(rrText(5.69)).toBe('+5.69')
    expect(rrText(-0.5)).toBe('-0.50')
    expect(rrText(null)).toBe('—')
  })
})
