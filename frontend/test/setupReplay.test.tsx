/**
 * The setup replay page. The report it renders is `backend/test/fixtures/setupReplay.json`,
 * written by the `research:setup-replay` CLI and held to that CLI's current output by
 * `backend/test/setupsRoute.test.ts`, so it cannot drift from the route.
 */
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const replay = JSON.parse(readFileSync(join(__dirname, '..', '..', 'backend', 'test', 'fixtures', 'setupReplay.json'), 'utf8'))

let calls: any[] = []
function mockApi(response: unknown, ok = true, status = 200) {
  calls = []
  vi.doMock('@/lib/apiFetch', () => ({
    apiFetch: vi.fn(async (path: string, init: any) => { calls.push({ path, init }); return { ok, status, json: async () => response } }),
  }))
}
beforeEach(() => vi.resetModules())
afterEach(() => vi.doUnmock('@/lib/apiFetch'))

async function fillAll(opts: { skip?: string } = {}) {
  const set = (label: string, value: string) => { if (opts.skip !== label) fireEvent.change(screen.getByLabelText(label), { target: { value } }) }
  set('Symbol A', 'spy'); set('Symbol B', 'QQQ')
  set('Timestamp convention', 'OPEN'); set('Round-trip cost per unit', '0.02')
  for (const l of ['CSV for A', 'CSV for B']) {
    if (opts.skip === l) continue
    const f = new File(['timestamp,open,high,low,close,volume\n'], 'bars.csv', { type: 'text/csv' })
    fireEvent.change(screen.getByLabelText(l), { target: { files: [f] } })
  }
}

describe('setup replay page', () => {
  test('empty: every required field is named, nothing is sent, and it says it is not evidence of an edge', async () => {
    mockApi(replay)
    const { SetupReplay } = await import('@/components/setups/SetupReplay')
    render(<SetupReplay />)
    const req = screen.getByRole('status').textContent ?? ''
    for (const f of ['Symbol A', 'Symbol B', 'CSV for symbol A', 'CSV for symbol B', 'Timestamp convention', 'Round-trip cost per unit']) expect(req).toContain(f)
    expect((screen.getByText('REPLAY') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/not evidence of an edge/)).toBeDefined()
    expect(screen.getAllByText('USER IMPORT').length).toBeGreaterThan(0)
    expect(calls.length).toBe(0)
  })

  test('required: no default for convention or cost; one missing keeps the run disabled', async () => {
    const { missingInputs } = await import('@/components/setups/SetupReplay')
    const base = { symbolA: 'SPY', symbolB: 'QQQ', fileA: 'x', fileB: 'y', marks: 'OPEN' as const, cost: '0' }
    expect(missingInputs(base)).toEqual([])
    expect(missingInputs({ ...base, marks: '' })).toEqual(['Timestamp convention'])
    expect(missingInputs({ ...base, cost: '' })).toEqual(['Round-trip cost per unit'])
    expect(missingInputs({ ...base, cost: '-1' })).toEqual(['Round-trip cost per unit (a non-negative number)'])
    expect(missingInputs({ ...base, symbolB: 'spy' })).toEqual(['Two different symbols'])
    mockApi(replay)
    const { SetupReplay } = await import('@/components/setups/SetupReplay')
    render(<SetupReplay />)
    await fillAll({ skip: 'Round-trip cost per unit' })
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Required: Round-trip cost per unit'))
    expect((screen.getByText('REPLAY') as HTMLButtonElement).disabled).toBe(true)
  })

  test('error: a refusal is listed reason by reason, and a non-answer is said plainly', async () => {
    mockApi({ status: 'REFUSED', reasons: ['SPY: line 3: high below low'] }, false, 400)
    let mod = await import('@/components/setups/SetupReplay')
    const { unmount } = render(<mod.SetupReplay />)
    await fillAll()
    await waitFor(() => expect((screen.getByText('REPLAY') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByText('REPLAY'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('SPY: line 3: high below low'))
    unmount()
    vi.resetModules(); vi.doUnmock('@/lib/apiFetch'); mockApi({}, false, 401)
    mod = await import('@/components/setups/SetupReplay')
    render(<mod.SetupReplay />)
    await fillAll()
    await waitFor(() => expect((screen.getByText('REPLAY') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByText('REPLAY'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('401'))
  })

  test('success: sends the trader\'s config verbatim and renders counts, blocked reasons and hashes', async () => {
    mockApi(replay)
    const { SetupReplay } = await import('@/components/setups/SetupReplay')
    render(<SetupReplay />)
    await fillAll()
    await waitFor(() => expect((screen.getByText('REPLAY') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByText('REPLAY'))
    await waitFor(() => expect(screen.getByText('REPLAY REPORT')).toBeDefined())
    expect(calls[0].path).toBe('/api/setups/replay')
    const sent = JSON.parse(calls[0].init.body)
    expect(sent.config).toEqual({ symbols: ['SPY', 'QQQ'], timestampMarks: 'OPEN', costs: { roundTripPerUnit: 0.02 } })
    expect(Object.keys(sent.csv)).toEqual(['SPY', 'QQQ'])
    const rep = replay.report
    for (const [k, v] of Object.entries(rep.counts.blockedByReason)) expect(screen.getByText(`${k}: ${v}`)).toBeDefined()
    for (const [k, v] of Object.entries(rep.counts.byTerminalState)) expect(screen.getByText(`${k}: ${v}`)).toBeDefined()
    expect(screen.getByText(`config ${rep.configHash}`)).toBeDefined()
    expect(document.body.textContent).toContain(rep.datasets[0].contentId)
    expect(document.body.textContent).not.toMatch(/win rate:|P&L:|\d+(\.\d+)?% win/i)
  })
})
