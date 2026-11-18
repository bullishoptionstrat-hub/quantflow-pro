/**
 * Desk layout persistence: a view preference kept in this browser. It may hide
 * panels; it may never hide the daily lock, and an unreadable stored value is
 * never overwritten.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import { useDeskLayout, ALWAYS_SHOWN, DESK_LAYOUT_KEY, DESK_PANELS, parseDeskLayout, serializeDeskLayout } from '@/lib/deskLayout'

vi.mock('@/lib/marketSession', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/marketSession')>()
  return { ...orig, useMarketSession: () => ({ panel: { status: 'unreachable' }, sources: { status: 'unreachable' } }) }
})
vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) }))

import DeskPage from '@/app/desk/page'

describe('parseDeskLayout', () => {
  test('nothing stored shows every panel', () => {
    expect(parseDeskLayout(null)).toEqual({ hidden: [], unknown: [], error: null })
    expect(parseDeskLayout('')).toEqual({ hidden: [], unknown: [], error: null })
  })
  test('known ids hide, unknown ids are kept, duplicates collapse', () => {
    const p = parseDeskLayout(JSON.stringify({ hidden: ['gex', 'gex', 'future-panel', 'sources'] }))
    expect(p).toEqual({ hidden: ['gex', 'sources'], unknown: ['future-panel'], error: null })
    expect(JSON.parse(serializeDeskLayout(p.hidden, p.unknown))).toEqual({ hidden: ['gex', 'sources', 'future-panel'] })
  })
  test('the risk panel cannot be hidden, by a stored value or by a save', () => {
    expect(ALWAYS_SHOWN).toContain('risk')
    expect(parseDeskLayout(JSON.stringify({ hidden: ['risk', 'gex'] })).hidden).toEqual(['gex'])
    expect(JSON.parse(serializeDeskLayout(['risk', 'gex'], []))).toEqual({ hidden: ['gex'] })
  })
  test.each([['{not json'], ['[]'], ['null'], ['{"hidden":"gex"}'], ['{"hidden":[1]}'], ['{}']])('unreadable %s is an error', (raw) => {
    const p = parseDeskLayout(raw)
    expect(p.error).toMatch(/left untouched/)
    expect(p.hidden).toEqual([])
  })
})

describe('desk page', () => {
  beforeEach(() => localStorage.clear())

  test('every panel is listed once, and hiding one removes it and persists', () => {
    render(<DeskPage />)
    const bar = screen.getByTestId('desk-layout')
    for (const p of DESK_PANELS) expect(within(bar).getByRole('button', { name: new RegExp(p.title) })).toBeTruthy()
    expect(screen.getByTestId('desk-gex')).toBeTruthy()
    fireEvent.click(within(bar).getByRole('button', { name: /GEX reference/ }))
    expect(screen.queryByTestId('desk-gex')).toBeNull()
    expect(JSON.parse(localStorage.getItem(DESK_LAYOUT_KEY)!)).toEqual({ hidden: ['gex'] })
    fireEvent.click(within(bar).getByRole('button', { name: /GEX reference/ }))
    expect(screen.getByTestId('desk-gex')).toBeTruthy()
    expect(JSON.parse(localStorage.getItem(DESK_LAYOUT_KEY)!)).toEqual({ hidden: [] })
  })

  test('a stored layout is applied on load, and the risk panel shows even when stored as hidden', () => {
    localStorage.setItem(DESK_LAYOUT_KEY, JSON.stringify({ hidden: ['session', 'risk', 'ticket'] }))
    render(<DeskPage />)
    expect(screen.queryByTestId('desk-session')).toBeNull()
    expect(screen.queryByTestId('desk-ticket')).toBeNull()
    expect(screen.getByTestId('desk-risk')).toBeTruthy()
    const risk = within(screen.getByTestId('desk-layout')).getByRole('button', { name: /Risk state/ }) as HTMLButtonElement
    expect(risk.disabled).toBe(true)
  })

  test('an unreadable stored layout shows every panel, says so, and is never overwritten', () => {
    localStorage.setItem(DESK_LAYOUT_KEY, '{broken')
    render(<DeskPage />)
    expect(screen.getByTestId('desk-layout-note').textContent).toMatch(/could not be read/)
    expect(screen.getByTestId('desk-gex')).toBeTruthy()
    const gex = within(screen.getByTestId('desk-layout')).getByRole('button', { name: /GEX reference/ }) as HTMLButtonElement
    expect(gex.disabled).toBe(true)
    fireEvent.click(gex)
    expect(localStorage.getItem(DESK_LAYOUT_KEY)).toBe('{broken')
    expect(screen.getByTestId('desk-gex')).toBeTruthy()
  })
})

test('the hook itself refuses to save over an unreadable layout, and to hide the risk panel', () => {
  localStorage.setItem(DESK_LAYOUT_KEY, '{broken')
  const { result } = renderHook(() => useDeskLayout())
  let why: string | null = null
  act(() => { why = result.current.toggle('gex') })
  expect(why).toMatch(/left untouched/)
  expect(localStorage.getItem(DESK_LAYOUT_KEY)).toBe('{broken')
  localStorage.clear()
  const ok = renderHook(() => useDeskLayout())
  act(() => { why = ok.result.current.toggle('risk') })
  expect(why).toMatch(/daily lock/)
  expect(localStorage.getItem(DESK_LAYOUT_KEY)).toBeNull()
})
