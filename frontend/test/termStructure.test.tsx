/**
 * ROADMAP 5.4 — the IV term structure panel.
 *
 * The hand-built payload is kept for the edge cases (a one-sided expiry, no
 * chain) and `backend/test/fixtures/vol.json` — a capture of the real route,
 * SPY, trade date 2026-10-21 — is rendered as well, so what a person sees is
 * checked against what the backend actually said and not only against a
 * shape someone typed.
 */
import { describe, expect, test } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VolResponse } from '@/lib/types'

const FIX = join(__dirname, '..', '..', 'backend', 'test', 'fixtures')
const captured = (): VolResponse => JSON.parse(readFileSync(join(FIX, 'vol.json'), 'utf8'))

const REFUSAL = 'Not reported. IV rank and IV percentile compare today\'s IV with a trailing history.'

const vol = (o: Partial<VolResponse> = {}): VolResponse => ({
  symbol: 'SPY', realData: true, unavailableReason: null, source: 'cboe',
  spot: 580, iv30: 18.34, tradeDate: '2026-09-24', asOf: '2026-09-24T15:45:00', delayedMinutes: 15,
  termStructure: {
    ivUnits: 'FRACTION',
    iv30Units: 'PERCENT',
    basis: 'Per expiry, the strike nearest spot that carries both a call and a put IV.',
    points: [
      { expiry: '2026-10-16', dte: 22, atmStrike: 580, distancePct: 0, callIv: 0.171, putIv: 0.189, atmIv: 0.18, ivMissing: 3, contracts: 200 },
      { expiry: '2026-12-18', dte: 85, atmStrike: null, distancePct: null, callIv: null, putIv: null, atmIv: null, ivMissing: 0, contracts: 0 },
    ],
  },
  skew: null,
  ivRank: null, ivPercentile: null, ivRankUnavailable: REFUSAL,
  ...o,
})

describe('the IV panel', () => {
  test('IV rank and percentile are refused, with the backend\'s reason verbatim', async () => {
    const { TermStructurePanel } = await import('@/components/gex/TermStructure')
    render(<TermStructurePanel panel={{ status: 'ok', data: vol() }} symbol="SPY" />)
    expect(screen.getByTestId('iv-rank').textContent).toMatch(/NOT REPORTED/)
    expect(screen.getByText(REFUSAL)).toBeDefined()
  })

  test('a fraction is shown as a percentage and iv30 is not multiplied twice', async () => {
    const { TermStructurePanel } = await import('@/components/gex/TermStructure')
    const { container } = render(<TermStructurePanel panel={{ status: 'ok', data: vol() }} symbol="SPY" />)
    const row = within(screen.getByTestId('term-table')).getByText('2026-10-16').closest('tr')!
    expect(row.textContent).toContain('17.10%')
    expect(row.textContent).toContain('18.90%')
    expect(row.textContent).toContain('18.00%')
    // The raw fraction is not on screen beside the percentage.
    expect(row.textContent).not.toMatch(/\b0\.18\b/)
    // iv30 arrived as 18.34 already; 1834% would be the double conversion.
    expect(container.textContent).toContain('18.34%')
    expect(container.textContent).not.toContain('1834')
    expect(screen.getByTestId('iv-basis').textContent).toMatch(/FRACTION/)
    expect(screen.getByTestId('iv-basis').textContent).toMatch(/PERCENT/)
  })

  test('the captured chain renders, and its 30-DTE ATM IV agrees with its own iv30', async () => {
    const { TermStructurePanel } = await import('@/components/gex/TermStructure')
    const data = captured()
    render(<TermStructurePanel panel={{ status: 'ok', data }} symbol={data.symbol} />)
    expect(screen.getByTestId('iv-rank').textContent).toMatch(/NOT REPORTED/)
    expect(screen.getByText(data.ivRankUnavailable)).toBeDefined()
    const pts = data.termStructure!.points
    expect(pts.length).toBeGreaterThan(5)
    const near30 = pts.filter((p) => p.dte !== null && p.atmIv !== null)
      .reduce((a, b) => (Math.abs(b.dte! - 30) < Math.abs(a.dte! - 30) ? b : a))
    // Scoped to the term-structure table: the skew table (5.5) lists the same expiries.
    const row = within(screen.getByTestId('term-table')).getByText(near30.expiry).closest('tr')!
    // What is on screen for that expiry is within a point of the headline iv30,
    // which Cboe publishes in percent — the same reading, so the same number.
    const shown = Number(row.textContent!.match(/(\d+\.\d{2})%\s*\d+ \/ \d+$/)![1])
    expect(Math.abs(shown - data.iv30!)).toBeLessThan(1.5)
  })

  test('an expiry with no two-sided ATM shows dashes, not zeros', async () => {
    const { TermStructurePanel } = await import('@/components/gex/TermStructure')
    render(<TermStructurePanel panel={{ status: 'ok', data: vol() }} symbol="SPY" />)
    const row = within(screen.getByTestId('term-table')).getByText('2026-12-18').closest('tr')!
    expect(row.textContent).not.toMatch(/\b0\.0+\b/)
    expect(row.textContent).toContain('—')
  })

  test('no chain draws nothing and says so, but the refusal still shows', async () => {
    const { TermStructurePanel } = await import('@/components/gex/TermStructure')
    render(<TermStructurePanel panel={{ status: 'ok', data: vol({
      realData: false, source: null, termStructure: null, iv30: null,
      unavailableReason: 'No Cboe chain has been received for SPY.',
    }) }} symbol="SPY" />)
    expect(screen.getByText(/No Cboe chain has been received for SPY\./)).toBeDefined()
    expect(screen.getByTestId('iv-rank').textContent).toMatch(/NOT REPORTED/)
    expect(screen.queryByRole('table')).toBeNull()
  })

  test('refused and unreachable read differently', async () => {
    const { TermStructurePanel } = await import('@/components/gex/TermStructure')
    const { rerender } = render(<TermStructurePanel panel={{ status: 'unauthorized' }} symbol="SPY" />)
    expect(screen.getByText(/refused this session/)).toBeDefined()
    rerender(<TermStructurePanel panel={{ status: 'unreachable' }} symbol="SPY" />)
    expect(screen.getByText(/did not answer/)).toBeDefined()
  })

  test('the two formatters convert once each and never invent a reading', async () => {
    const { ivPct, iv30Pct } = await import('@/components/gex/TermStructure')
    expect(ivPct(0.183456)).toBe('18.35%')
    expect(iv30Pct(18.3456)).toBe('18.35%')
    expect(ivPct(null)).toBe('—')
    expect(iv30Pct(null)).toBe('—')
  })
})
