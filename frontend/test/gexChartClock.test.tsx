/**
 * The GEX chart's clock names the chain's as-of, never `updatedAt`.
 * `updatedAt` is when this server answered; showing it as the chart's time
 * presented a 15-minute-delayed chain as current.
 */
import { describe, expect, test, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chainClockText, gexContext } from '@/lib/gexContext'

const FIX = join(__dirname, '..', '..', 'backend', 'test', 'fixtures')
const base = () => JSON.parse(readFileSync(join(FIX, 'gex.json'), 'utf8'))

function mockApi(body: unknown) {
  vi.doMock('@/lib/apiFetch', () => ({
    apiFetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => body })),
  }))
}
beforeEach(() => vi.resetModules())

describe('chainClockText', () => {
  test('a published chain time is shown in ET', () => {
    const r = { ...base(), asOf: '2026-11-11T19:45:00.000Z', updatedAt: '2026-11-18T12:00:00.000Z' }
    expect(chainClockText(gexContext(r, 'SPY'))).toBe('chain as of 2026-11-11 14:45:00 ET')
  })
  test('null asOf from the backend is "carried no time"', () => {
    expect(chainClockText(gexContext({ ...base(), asOf: null }, 'SPY'))).toBe('chain carried no time')
  })
  test('an absent asOf is "not published", not a time', () => {
    const r = base(); delete r.asOf
    expect(chainClockText(gexContext(r, 'SPY'))).toBe('chain time not published by backend')
  })
  test('an unreadable asOf is not a time', () => {
    expect(chainClockText(gexContext({ ...base(), asOf: 'garbage' }, 'SPY'))).toBe('chain carried no time')
  })
  test('no chain, or a chain for another symbol, has no clock', () => {
    expect(chainClockText(gexContext({ ...base(), realData: false, asOf: '2026-11-11T19:45:00Z' }, 'SPY'))).toBe('no chain')
    expect(chainClockText(gexContext({ ...base(), asOf: '2026-11-11T19:45:00Z' }, 'QQQ'))).toBe('no chain')
  })
})

describe('GEXChart', () => {
  test('renders the chain as-of and not the response time', async () => {
    mockApi({ ...base(), asOf: '2026-11-11T19:45:00.000Z', updatedAt: '2026-11-18T17:00:00.000Z' })
    const { GEXChart } = await import('@/components/gex/GEXChart')
    render(<GEXChart />)
    await waitFor(() => expect(screen.getByText(/chain as of 2026-11-11 14:45:00 ET/)).toBeDefined())
    expect(screen.queryByText(/12:00:00|17:00:00/)).toBeNull()
  })
  test('source never reads updatedAt', () => {
    const src = readFileSync(join(__dirname, '..', 'components', 'gex', 'GEXChart.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(src).not.toMatch(/updatedAt/)
  })
})
