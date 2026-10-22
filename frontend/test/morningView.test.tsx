/**
 * ROADMAP 5.2 — the morning view, driven by recorded payloads wherever one
 * exists.
 *
 * `gex.json`, `track.json` and `flow.json` are captures from a live backend
 * (`npm run preview:capture`). `/api/flow/overnight` is new in this change and
 * has no capture yet, so its envelope is built here around the recorded
 * `flow.json` rows. That is the weakest evidence in this file and is said so:
 * the window and coverage shapes are held to the backend by
 * `backend/test/overnightWindow.test.ts`, not by a capture.
 */
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OvernightFlowResponse } from '@/lib/types'

const FIX = join(__dirname, '..', '..', 'backend', 'test', 'fixtures')
const fixture = (n: string) => JSON.parse(readFileSync(join(FIX, `${n}.json`), 'utf8'))

function overnight(over: Partial<OvernightFlowResponse> = {}): OvernightFlowResponse {
  const rows = fixture('flow').data
  return {
    window: {
      authority: 'EXCHANGE_REGULAR_SESSION', state: 'ESTABLISHED',
      from: '2026-09-25T20:00:00.000Z', to: '2026-09-28T12:00:00.000Z',
      closedBySessionOpen: false,
      basis: '2026-09-25 closed at 16:00 ET (regular session); 2026-09-28\'s open has not come',
    },
    data: rows,
    count: rows.length,
    synthetic: rows.filter((r: { synthetic?: boolean }) => r.synthetic === true).length,
    coverage: {
      buffered: rows.length, cap: 500, oldestBufferedAt: rows[rows.length - 1]?.created_at ?? null,
      processStartedAt: '2026-09-25T12:00:00.000Z', complete: true,
      basis: 'the process was running for the whole window and the buffer has never been full',
    },
    ...over,
  }
}

beforeEach(() => vi.resetModules())
afterEach(() => vi.doUnmock('@/lib/apiFetch'))

describe('overnight flow', () => {
  test('the window is the backend\'s, with its basis, rendered in New York time', async () => {
    const { OvernightPanel } = await import('@/components/morning/MorningView')
    const o = overnight()
    render(<OvernightPanel panel={{ status: 'ok', data: o }} />)
    expect(screen.getByTestId('overnight-basis').textContent).toContain(o.window.basis)
    // Friday's 20:00Z close is 16:00 in New York.
    expect(screen.getByText(/Fri Sep 25 16:00 ET → now/)).toBeDefined()
    expect(screen.getByTestId('overnight-coverage').textContent).toMatch(/^Whole window seen/)
  })

  test('a window the process could not fully see says PARTIAL, and why', async () => {
    const { OvernightPanel } = await import('@/components/morning/MorningView')
    const o = overnight()
    o.coverage = { ...o.coverage, complete: false, basis: 'this process started after the window opened, so earlier flow was never seen' }
    render(<OvernightPanel panel={{ status: 'ok', data: o }} />)
    const cov = screen.getByTestId('overnight-coverage').textContent ?? ''
    expect(cov).toMatch(/PARTIAL WINDOW/)
    expect(cov).toContain('started after the window opened')
    expect(cov).not.toMatch(/Whole window/)
  })

  test('an UNKNOWN window is not drawn as an empty night', async () => {
    const { OvernightPanel } = await import('@/components/morning/MorningView')
    const o = overnight({
      window: {
        authority: 'EXCHANGE_REGULAR_SESSION', state: 'UNKNOWN', from: null, to: null,
        closedBySessionOpen: false, basis: '2025-12-31: outside the calendar\'s coverage',
      },
      data: [], count: 0, synthetic: 0,
    })
    render(<OvernightPanel panel={{ status: 'ok', data: o }} />)
    expect(screen.getByText(/cannot establish when the last regular close was/)).toBeDefined()
    expect(screen.getByText(/outside the calendar's coverage/)).toBeDefined()
    expect(screen.queryByText(/No signal arrived/)).toBeNull()
    expect(screen.queryByText(/signals:/)).toBeNull()
  })

  test('non-observed prints are counted, and never called simulated', async () => {
    const { OvernightPanel } = await import('@/components/morning/MorningView')
    const o = overnight()
    expect(o.synthetic).toBeGreaterThan(0) // the capture is a keyless boot
    const { container } = render(<OvernightPanel panel={{ status: 'ok', data: o }} />)
    expect(container.textContent).toMatch(/not observed prints/)
    expect(container.textContent).not.toMatch(/simulated|SIMULATED/)
  })

  test('an empty window says nothing arrived, with no invented totals', async () => {
    const { OvernightPanel } = await import('@/components/morning/MorningView')
    const o = overnight({ data: [], count: 0, synthetic: 0 })
    const { container } = render(<OvernightPanel panel={{ status: 'ok', data: o }} />)
    expect(screen.getByText(/No signal arrived inside the window\./)).toBeDefined()
    expect(container.textContent).not.toMatch(/\$0/)
  })
})

describe('GEX profile and the gamma flip', () => {
  test('the flip is the backend\'s refusal, with its reason verbatim', async () => {
    const { GexPanel } = await import('@/components/morning/MorningView')
    const g = fixture('gex')
    expect(g.flipStrike).toBeNull()
    expect(typeof g.flipUnavailable).toBe('string')
    render(<GexPanel panel={{ status: 'ok', data: g }} symbol="SPY" />)
    const flip = screen.getByTestId('gamma-flip').textContent ?? ''
    expect(flip).toMatch(/NOT PUBLISHED/)
    expect(flip).toContain(g.flipUnavailable)
  })

  test('a flip the view did not receive is never computed from the levels', async () => {
    // The fixture's levels change sign somewhere; the removed rule would have
    // published that strike. Nothing between the label and the reason may be
    // a strike from the chain.
    const { GexPanel } = await import('@/components/morning/MorningView')
    const g = fixture('gex')
    render(<GexPanel panel={{ status: 'ok', data: g }} symbol="SPY" />)
    const flip = (screen.getByTestId('gamma-flip').textContent ?? '').replace(g.flipUnavailable, '')
    const strikes = new Set(g.levels.map((l: { strike: number }) => String(l.strike)))
    const numbers = flip.match(/\d+(\.\d+)?/g) ?? []
    expect(numbers.filter((n) => strikes.has(n))).toEqual([])
  })

  test('the dealer-positioning assumption is rendered beside the number', async () => {
    const { GexPanel } = await import('@/components/morning/MorningView')
    const g = fixture('gex')
    const values = Object.values(g.assumptions as Record<string, string>)
    expect(values.length).toBeGreaterThan(0)
    render(<GexPanel panel={{ status: 'ok', data: g }} symbol="SPY" />)
    for (const v of values) expect(screen.getByText(v)).toBeDefined()
    expect(screen.getByText('MODELLED, NOT OBSERVED')).toBeDefined()
  })

  test('no real chain draws nothing and says so', async () => {
    const { GexPanel } = await import('@/components/morning/MorningView')
    const g = { ...fixture('gex'), realData: false, levels: [], unavailableReason: 'No Cboe chain has been received for SPY.' }
    render(<GexPanel panel={{ status: 'ok', data: g }} symbol="SPY" />)
    expect(screen.getByText('NO REAL CHAIN')).toBeDefined()
    expect(screen.getByText(/No Cboe chain has been received/)).toBeDefined()
    expect(screen.queryByTestId('gamma-flip')).toBeNull()
  })
})

describe('track record to date', () => {
  test('real: 0 is said in words, and the notes and disclaimer are verbatim', async () => {
    const { TrackRecordPanel } = await import('@/components/morning/MorningView')
    const t = fixture('track')
    expect(t.counts.real).toBe(0)
    render(<TrackRecordPanel panel={{ status: 'ok', data: t }} />)
    expect(screen.getByTestId('no-real-record').textContent).toMatch(/No real signal has been recorded/)
    for (const n of t.notes) expect(screen.getByText(n)).toBeDefined()
    expect(screen.getByText(t.disclaimer)).toBeDefined()
  })

  test('a suppressed rate renders SUPPRESSED with its sample, never a zero', async () => {
    const { TrackRecordPanel } = await import('@/components/morning/MorningView')
    const t = {
      ...fixture('track'),
      counts: { total: 40, synthetic: 28, real: 12 },
      rows: [{
        kind: 'SWEEP', horizon: 'M15', nTotal: 12, nGraded: 12, nUngraded: 0,
        suppressionReason: 'INSUFFICIENT_SAMPLE',
      }],
    }
    const { container } = render(<TrackRecordPanel panel={{ status: 'ok', data: t }} />)
    expect(screen.getByText(/SUPPRESSED \(n<30\) · n=12/)).toBeDefined()
    expect(container.textContent).not.toMatch(/0\.0%|\b0%/)
    expect(screen.queryByTestId('no-real-record')).toBeNull()
  })

  test('a published rate renders as a percentage', async () => {
    const { TrackRecordPanel } = await import('@/components/morning/MorningView')
    const t = {
      ...fixture('track'),
      counts: { total: 80, synthetic: 30, real: 50 },
      rows: [{ kind: 'BLOCK', horizon: 'H1', nTotal: 40, nGraded: 36, nUngraded: 4, hitRate: 0.5556 }],
    }
    render(<TrackRecordPanel panel={{ status: 'ok', data: t }} />)
    expect(screen.getByText('55.6%')).toBeDefined()
  })
})

describe('panel states', () => {
  test('refused, unreachable and loading are three different sentences', async () => {
    const { TrackRecordPanel } = await import('@/components/morning/MorningView')
    const { rerender } = render(<TrackRecordPanel panel={{ status: 'unauthorized' }} />)
    expect(screen.getByText(/refused this session/)).toBeDefined()
    rerender(<TrackRecordPanel panel={{ status: 'unreachable' }} />)
    expect(screen.getByText(/did not answer/)).toBeDefined()
    rerender(<TrackRecordPanel panel={{ status: 'loading' }} />)
    expect(screen.getByText(/Loading the track record/)).toBeDefined()
  })
})

describe('the whole screen', () => {
  test('reads all four endpoints, and an older backend\'s missing session is SESSION UNKNOWN', async () => {
    const calls: string[] = []
    const bodies: Record<string, unknown> = {
      '/api/flow/overnight': overnight(),
      '/api/track-record': fixture('track'),
      '/api/gex?symbol=SPY': fixture('gex'),
      '/api/health': fixture('health'), // captured before the session block existed
    }
    vi.doMock('@/lib/apiFetch', () => ({
      apiFetch: vi.fn(async (path: string) => {
        calls.push(path)
        const body = bodies[path]
        return body === undefined
          ? { ok: false, status: 404, json: async () => ({}) }
          : { ok: true, status: 200, json: async () => body }
      }),
    }))
    const { MorningView } = await import('@/components/morning/MorningView')
    render(<MorningView />)

    await waitFor(() => expect(screen.getByTestId('no-real-record')).toBeDefined())
    await waitFor(() => expect(screen.getByTestId('gamma-flip')).toBeDefined())
    await waitFor(() => expect(screen.getByTestId('overnight-basis')).toBeDefined())
    expect(screen.getByTestId('session-label').textContent).toBe('SESSION UNKNOWN')
    expect(calls).toEqual(expect.arrayContaining(Object.keys(bodies)))
  })
})

describe('etInstant', () => {
  test('renders New York wall time across both offsets, and — for nothing', async () => {
    const { etInstant } = await import('@/components/morning/MorningView')
    expect(etInstant('2026-09-25T20:00:00.000Z')).toBe('Fri Sep 25 16:00 ET')
    expect(etInstant('2026-11-27T18:00:00.000Z')).toBe('Fri Nov 27 13:00 ET')
    expect(etInstant(null)).toBe('—')
    expect(etInstant('not a date')).toBe('—')
  })
})
