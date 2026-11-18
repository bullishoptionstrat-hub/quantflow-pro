/**
 * The per-idea drill-down. It re-decides nothing; it reports where the
 * engine's own fields contradict each other and repairs nothing.
 */
import { describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ideaTimeline, parseBarId } from '@/lib/ideaTimeline'

const episodes = JSON.parse(readFileSync(join(__dirname, '..', '..', 'backend', 'test', 'fixtures', 'setupReplayEpisodes.json'), 'utf8'))
const ideas = episodes.report.runs.flatMap((r: { ideas: unknown[] }) => r.ideas) as { history: Parameters<typeof ideaTimeline>[0] }[]

const T0 = 1767623880000
const row = (state: string, knownAt: number, barOpen: number, o: object = {}) => ({ state, knownAt, bar: `SPY:1m:${barOpen}`, reasons: [], ...o })

describe('parseBarId', () => {
  test('reads symbol, open and a close one timeframe later', () => {
    expect(parseBarId(`SPY:1m:${T0}`)).toEqual({ symbol: 'SPY', open: T0, close: T0 + 60_000 })
    expect(parseBarId(`QQQ:5m:${T0}`)?.close).toBe(T0 + 300_000)
  })
  test('refuses what it cannot read rather than guessing', () => {
    for (const bad of ['', 'SPY', 'SPY:1m:', 'SPY:0m:1', 'SPY:1h:1', `SPY:1m:${T0}x`, 'spy:1m:1']) expect(parseBarId(bad)).toBeNull()
  })
})

describe('ideaTimeline', () => {
  test('every recorded engine idea is knowable no earlier than its cited bar closed, in order', () => {
    expect(ideas.length).toBeGreaterThan(0)
    for (const i of ideas) {
      const rows = ideaTimeline(i.history)
      expect(rows).toHaveLength(i.history.length)
      for (const r of rows) expect(r.flags).toEqual([])
      expect(rows[0].sinceStartMin).toBe(0)
    }
  })

  test('a transition knowable before its bar closed is flagged, not moved', () => {
    const rows = ideaTimeline([row('OBSERVING', T0 + 60_000, T0), row('ACTIONABLE', T0 + 90_000, T0 + 60_000)])
    expect(rows[1].flags).toEqual(['BEFORE_BAR_CLOSE'])
    expect(rows[1].knownAt).toBe(T0 + 90_000)
  })

  test('knownAt exactly at the close is fine', () => {
    expect(ideaTimeline([row('A', T0 + 60_000, T0)])[0].flags).toEqual([])
  })

  test('out-of-order rows are flagged and stay where the engine put them', () => {
    const rows = ideaTimeline([row('A', T0 + 180_000, T0), row('B', T0 + 120_000, T0), row('C', T0 + 240_000, T0)])
    expect(rows.map((r) => r.state)).toEqual(['A', 'B', 'C'])
    expect(rows.map((r) => r.flags)).toEqual([[], ['OUT_OF_ORDER'], []])
    expect(rows.map((r) => r.sinceStartMin)).toEqual([0, -1, 1])
  })

  test('a row earlier than one already seen stays flagged after a later recovery', () => {
    const rows = ideaTimeline([row('A', T0 + 240_000, T0), row('B', T0 + 120_000, T0), row('C', T0 + 180_000, T0)])
    expect(rows.map((r) => r.flags)).toEqual([[], ['OUT_OF_ORDER'], ['OUT_OF_ORDER']])
  })

  test('an unreadable bar or clock is null with a flag, never zero', () => {
    const rows = ideaTimeline([{ state: 'X', knownAt: NaN, bar: 'nope', reasons: [] }])
    expect(rows[0].knownAt).toBeNull()
    expect(rows[0].barClose).toBeNull()
    expect(rows[0].sinceStartMin).toBeNull()
    expect(rows[0].flags).toEqual(['KNOWN_AT_UNREADABLE', 'BAR_UNREADABLE'])
  })

  test('reasons and cited events pass through', () => {
    const r = ideaTimeline([row('BLOCKED', T0 + 60_000, T0, { reasons: [{ code: 'NO_SMT', detail: 'd' }], events: ['E1'] })])[0]
    expect(r.reasons).toEqual([{ code: 'NO_SMT', detail: 'd' }])
    expect(r.events).toEqual(['E1'])
  })
})

describe('the /setups drill-down', () => {
  test('renders one row per transition, with no flag on recorded engine output', async () => {
    vi.resetModules()
    vi.doMock('@/lib/apiFetch', () => ({ apiFetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => episodes })) }))
    const { SetupReplay } = await import('@/components/setups/SetupReplay')
    render(<SetupReplay />)
    const set = (l: string, v: string) => fireEvent.change(screen.getByLabelText(l), { target: { value: v } })
    set('Symbol A', 'SPY'); set('Symbol B', 'QQQ'); set('Timestamp convention', 'OPEN'); set('Round-trip cost per unit', '0.02')
    for (const l of ['CSV for A', 'CSV for B']) fireEvent.change(screen.getByLabelText(l), { target: { files: [new File(['t\n'], 'b.csv')] } })
    await waitFor(() => expect((screen.getByText('REPLAY') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByText('REPLAY'))
    await waitFor(() => expect(screen.getAllByTestId('idea-timeline').length).toBe(ideas.length))
    const total = ideas.reduce((a, i) => a + i.history.length, 0)
    expect(screen.getAllByTestId('timeline-row')).toHaveLength(total)
    expect(screen.queryAllByTestId('timeline-flag')).toHaveLength(0)
    vi.doUnmock('@/lib/apiFetch')
  })
})
