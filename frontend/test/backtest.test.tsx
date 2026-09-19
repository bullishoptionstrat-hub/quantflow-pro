/**
 * The scanner-backtest page, driven by a response the backend really gave.
 *
 * `backend/test/fixtures/backtest.json` was captured from a live
 * `POST /api/backtest`, not hand-authored — the same discipline as every other
 * page fixture. What these check is the half text-matching on the backend
 * cannot reach: that a suppressed rate never renders as a number, that the
 * measured-interval drift is visible, and that the backend's notes and
 * disclaimer reach the reader verbatim.
 */
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const FIX = join(__dirname, '..', '..', 'backend', 'test', 'fixtures')
const fixture = (n: string) => JSON.parse(readFileSync(join(FIX, `${n}.json`), 'utf8'))

/** Serve a captured payload through the module the page actually calls. */
function mockApi(response: unknown, ok = true, status = 200) {
  vi.doMock('@/lib/apiFetch', () => ({
    apiFetch: vi.fn(async () => ({ ok, status, json: async () => response })),
  }))
}

beforeEach(() => {
  vi.resetModules()
  window.localStorage.clear()
})
afterEach(() => vi.doUnmock('@/lib/apiFetch'))

describe('scanner backtest', () => {
  test('runs a filter and renders the published hit rate', async () => {
    const body = fixture('backtest')
    expect(body.rows[0].hitRate).toBe(0.7)
    mockApi(body)
    const { Backtest } = await import('@/components/backtest/Backtest')

    render(<Backtest />)
    fireEvent.click(screen.getByText('RUN BACKTEST'))
    await waitFor(() => expect(screen.getByText('70.0%')).toBeDefined())
    expect(screen.getByText('BACKTEST RESULT')).toBeDefined()
  })

  test('renders the backend notes and disclaimer verbatim', async () => {
    const body = fixture('backtest')
    mockApi(body)
    const { Backtest } = await import('@/components/backtest/Backtest')

    render(<Backtest />)
    fireEvent.click(screen.getByText('RUN BACKTEST'))
    // The measured-interval disclosure and the synthetic-exclusion note are the
    // sentences that keep the number honest — they are shown, not summarised.
    await waitFor(() => expect(screen.getByText(body.notes[0])).toBeDefined())
    expect(screen.getByText(body.notes[1])).toBeDefined()
    expect(screen.getByText(body.disclaimer)).toBeDefined()
  })

  test('shows the measured interval beside the horizon it drifted from', async () => {
    // The fixture's M15 row was measured over 32 minutes. That mismatch must be
    // visible on the row, not only buried in the note.
    const body = fixture('backtest')
    expect(body.rows[0].measuredInterval.medianMs).toBe(1_920_000) // 32 min
    mockApi(body)
    const { Backtest } = await import('@/components/backtest/Backtest')

    render(<Backtest />)
    fireEvent.click(screen.getByText('RUN BACKTEST'))
    await waitFor(() => expect(screen.getByText(/32min \/ 15 nominal/)).toBeDefined())
  })

  test('a suppressed rate renders SUPPRESSED, never a zero', async () => {
    // The single most important cell: below n=30 there is no hitRate field, and
    // the page must not manufacture one. A 0% here would be the category's lie.
    const body = {
      ...fixture('backtest'),
      rows: [{
        kind: 'BLOCK', horizon: 'M15', nTotal: 12, nGraded: 12, nUngraded: 0,
        suppressionReason: 'INSUFFICIENT_SAMPLE',
        measuredInterval: { n: 12, nUndated: 0, nominalMs: 900_000, medianMs: 900_000, minMs: 900_000, maxMs: 900_000 },
      }],
    }
    mockApi(body)
    const { Backtest } = await import('@/components/backtest/Backtest')

    render(<Backtest />)
    fireEvent.click(screen.getByText('RUN BACKTEST'))
    await waitFor(() => expect(screen.getByText(/SUPPRESSED/)).toBeDefined())
    expect(screen.queryByText('0.0%')).toBeNull()
    expect(screen.queryByText('0%')).toBeNull()
  })

  test('an empty match states it is about the filter, not a signal', async () => {
    const body = {
      ...fixture('backtest'),
      matched: 0, rows: [],
      excluded: { synthetic: 0, eventTimeOnlyBasis: 0, rightsRefused: 0 },
      notes: ['No signal in the record matched this scanner filter.'],
    }
    mockApi(body)
    const { Backtest } = await import('@/components/backtest/Backtest')

    render(<Backtest />)
    fireEvent.click(screen.getByText('RUN BACKTEST'))
    await waitFor(() => expect(screen.getByText(/statement about the filter/i)).toBeDefined())
  })

  test('a 400 surfaces the backend detail, not a bare status', async () => {
    mockApi({ error: 'Invalid scanner filter.', detail: 'An empty set matches nothing.' }, false, 400)
    const { Backtest } = await import('@/components/backtest/Backtest')

    render(<Backtest />)
    fireEvent.click(screen.getByText('RUN BACKTEST'))
    await waitFor(() => expect(screen.getByText(/An empty set matches nothing/)).toBeDefined())
  })

  test('an unreachable backend shows the failure rather than an empty table', async () => {
    vi.doMock('@/lib/apiFetch', () => ({
      apiFetch: vi.fn(async () => { throw new Error('connection refused') }),
    }))
    const { Backtest } = await import('@/components/backtest/Backtest')

    render(<Backtest />)
    fireEvent.click(screen.getByText('RUN BACKTEST'))
    await waitFor(() => expect(screen.getByText(/did not run — connection refused/)).toBeDefined())
    expect(screen.queryByText('BACKTEST RESULT')).toBeNull()
  })
})

describe('saved presets on the page', () => {
  test('saving a named scanner makes it appear and reloadable', async () => {
    mockApi(fixture('backtest'))
    const { Backtest } = await import('@/components/backtest/Backtest')

    render(<Backtest />)
    // Build a small filter: select SWEEP, then name and save it.
    fireEvent.click(screen.getByText('SWEEP'))
    fireEvent.change(screen.getByPlaceholderText('Name this scanner…'), { target: { value: 'My Sweeps' } })
    fireEvent.click(screen.getByText('SAVE PRESET'))

    await waitFor(() => expect(screen.getByTitle('Load this scanner into the filter')).toBeDefined())
    expect(screen.getByText('My Sweeps')).toBeDefined()
    // And it persisted to localStorage, which is the whole point.
    expect(window.localStorage.getItem('qf_scanner_presets')).toContain('My Sweeps')
  })

  test('deleting a preset removes it', async () => {
    mockApi(fixture('backtest'))
    const { Backtest } = await import('@/components/backtest/Backtest')

    render(<Backtest />)
    fireEvent.click(screen.getByText('SWEEP'))
    fireEvent.change(screen.getByPlaceholderText('Name this scanner…'), { target: { value: 'Temp' } })
    fireEvent.click(screen.getByText('SAVE PRESET'))
    await waitFor(() => expect(screen.getByText('Temp')).toBeDefined())

    fireEvent.click(screen.getByLabelText('delete Temp'))
    await waitFor(() => expect(screen.queryByText('Temp')).toBeNull())
  })
})
