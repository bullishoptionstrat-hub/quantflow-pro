/**
 * The bar-import preflight panel on /setups. The report it renders is
 * `backend/test/fixtures/barPreflight.json`, recorded from the route and held
 * to it by `backend/test/barPreflight.test.ts`.
 */
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const recorded = JSON.parse(readFileSync(join(__dirname, '..', '..', 'backend', 'test', 'fixtures', 'barPreflight.json'), 'utf8'))

let calls: any[] = []
function mockApi(response: unknown, ok = true, status = 200) {
  calls = []
  vi.doMock('@/lib/apiFetch', () => ({
    apiFetch: vi.fn(async (path: string, init: any) => { calls.push({ path, init }); return { ok, status, json: async () => response } }),
  }))
}
beforeEach(() => vi.resetModules())
afterEach(() => vi.doUnmock('@/lib/apiFetch'))

async function fill(opts: { cost?: boolean } = {}) {
  const set = (l: string, v: string) => fireEvent.change(screen.getByLabelText(l), { target: { value: v } })
  set('Symbol A', 'spy'); set('Symbol B', 'flawed'); set('Timestamp convention', 'OPEN')
  if (opts.cost) set('Round-trip cost per unit', '0.02')
  for (const l of ['CSV for A', 'CSV for B']) fireEvent.change(screen.getByLabelText(l), { target: { files: [new File(['t\n'], 'b.csv')] } })
}

describe('bar preflight panel', () => {
  test('needs symbols, both files and the convention, but not the cost; sends no cost', async () => {
    mockApi(recorded)
    const { SetupReplay } = await import('@/components/setups/SetupReplay')
    render(<SetupReplay />)
    expect((screen.getByText('PREFLIGHT') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('preflight-missing').textContent).toMatch(/Timestamp convention/)
    expect(screen.getByTestId('preflight-missing').textContent).not.toMatch(/cost/)
    await fill()
    await waitFor(() => expect((screen.getByText('PREFLIGHT') as HTMLButtonElement).disabled).toBe(false))
    expect((screen.getByText('REPLAY') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByText('PREFLIGHT'))
    await waitFor(() => expect(screen.getByTestId('preflight-report')).toBeDefined())
    expect(calls).toHaveLength(1)
    expect(calls[0].path).toBe('/api/setups/preflight')
    const sent = JSON.parse(calls[0].init.body)
    expect(sent.config).toEqual({ timestampMarks: 'OPEN' })
    expect(Object.keys(sent.csv)).toEqual(['SPY', 'FLAWED'])
  })

  test('renders the recorded report: rejected rows by reason, RTH minutes missing, a weekend named, the clean file says so', async () => {
    mockApi(recorded)
    const { SetupReplay } = await import('@/components/setups/SetupReplay')
    render(<SetupReplay />)
    await fill()
    await waitFor(() => expect((screen.getByText('PREFLIGHT') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByText('PREFLIGHT'))
    const flawed = await screen.findByTestId('preflight-FLAWED')
    const reasons = within(flawed).getByRole('list', { name: 'FLAWED rejected rows by reason' }).textContent ?? ''
    for (const c of ['TIMESTAMP', 'BAR_SHAPE', 'DUPLICATE', 'OUT_OF_ORDER']) expect(reasons).toContain(c)
    expect(flawed.textContent).toContain('inside the regular session: 1845 min')
    expect(within(flawed).getByRole('note').textContent).toMatch(/2026-01-10 \(WEEKEND\)/)
    expect(flawed.textContent).toContain('WEEKEND')
    const spy = screen.getByTestId('preflight-SPY')
    expect(spy.textContent).toContain('Nothing to flag.')
    expect(spy.textContent).toContain('100.0%')
  })

  test('a calendar that cannot answer renders as not computed, never as zero', async () => {
    const body = structuredClone(recorded)
    body.symbols[0].gaps.insideRthMinutes = null
    body.symbols[0].days[0] = { ...body.symbols[0].days[0], session: 'UNKNOWN', rthBars: null, rthMinutes: null, rthCoverage: null, outsideRthBars: null }
    mockApi(body)
    const { SetupReplay } = await import('@/components/setups/SetupReplay')
    render(<SetupReplay />)
    await fill()
    await waitFor(() => expect((screen.getByText('PREFLIGHT') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByText('PREFLIGHT'))
    const spy = await screen.findByTestId('preflight-SPY')
    expect(spy.textContent).toContain('not computed (calendar cannot answer)')
    expect(spy.textContent).toMatch(/UNKNOWN\d+——/)
  })

  test('a refusal is shown by name, and a body that is not a preflight is not rendered as one', async () => {
    mockApi({ status: 'REFUSED', reasons: ['config.timestampMarks: OPEN or CLOSE is required'] }, false, 400)
    let mod = await import('@/components/setups/SetupReplay')
    const { unmount } = render(<mod.SetupReplay />)
    await fill()
    await waitFor(() => expect((screen.getByText('PREFLIGHT') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByText('PREFLIGHT'))
    expect((await screen.findByRole('alert')).textContent).toMatch(/timestampMarks/)
    unmount()
    vi.resetModules()
    mockApi({ status: 'OK', report: {} })
    mod = await import('@/components/setups/SetupReplay')
    render(<mod.SetupReplay />)
    await fill()
    await waitFor(() => expect((screen.getByText('PREFLIGHT') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByText('PREFLIGHT'))
    expect((await screen.findByRole('alert')).textContent).toMatch(/without a preflight report/)
  })
})
