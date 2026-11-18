/**
 * Desk hotkeys: `g` + a key jumps to a page, `?` lists the keys, `/` opens the
 * palette. Navigation only, never while typing, never with a modifier.
 */
import { describe, expect, test, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const push = vi.fn()
vi.mock('next/navigation', () => ({ usePathname: () => '/desk', useRouter: () => ({ push }) }))

import { NAV, hotkeyTarget } from '@/lib/nav'
import { Hotkeys, CHORD_MS } from '@/components/hud/Hotkeys'
import { OPEN_PALETTE_EVENT } from '@/components/hud/CommandPalette'

beforeEach(() => push.mockReset())
const key = (k: string, init: KeyboardEventInit = {}, target: Element | Window = window) =>
  fireEvent.keyDown(target, { key: k, ...init })

describe('hotkeys', () => {
  test('every page has exactly one key, and no two pages share one', () => {
    const keys = NAV.map((n) => n.key)
    expect(keys.every((k) => typeof k === 'string' && k.length === 1)).toBe(true)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).not.toContain('g')
    for (const n of NAV) expect(hotkeyTarget(n.key)?.href).toBe(n.href)
    expect(hotkeyTarget('D')?.href).toBe('/desk')
    expect(hotkeyTarget('q')).toBeNull()
  })

  test('g then a key navigates to that page', () => {
    render(<Hotkeys />)
    for (const n of NAV) {
      key('g'); key(n.key)
      expect(push).toHaveBeenLastCalledWith(n.href)
    }
    expect(push).toHaveBeenCalledTimes(NAV.length)
  })

  test('a key without g does nothing, and g expires', () => {
    vi.useFakeTimers()
    try {
      render(<Hotkeys />)
      key('d')
      expect(push).not.toHaveBeenCalled()
      key('g'); act(() => { vi.advanceTimersByTime(CHORD_MS + 1) }); key('d')
      expect(push).not.toHaveBeenCalled()
      key('g'); key('Escape'); key('d')
      expect(push).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  test('nothing fires while typing in a field or with a modifier held', () => {
    const { container } = render(<div><input aria-label="field" /><Hotkeys /></div>)
    const input = container.querySelector('input')!
    key('g', {}, input); key('d', {}, input)
    expect(push).not.toHaveBeenCalled()
    key('g', { ctrlKey: true }); key('d')
    expect(push).not.toHaveBeenCalled()
    key('g'); key('d', { metaKey: true })
    expect(push).not.toHaveBeenCalled()
    key('?', {}, input)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('? lists exactly NAV with its keys, and Esc closes it', () => {
    render(<Hotkeys />)
    key('?')
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' })
    const hrefs = Array.from(dialog.querySelectorAll('[data-href]')).map((e) => e.getAttribute('data-href'))
    expect(hrefs).toEqual(NAV.map((n) => n.href))
    for (const n of NAV) expect(dialog.textContent).toContain(`g ${n.key}`)
    expect(dialog.textContent).toMatch(/Navigation only/)
    key('Escape')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('/ opens the page palette', () => {
    const seen = vi.fn()
    window.addEventListener(OPEN_PALETTE_EVENT, seen)
    render(<Hotkeys />)
    key('/')
    expect(seen).toHaveBeenCalledTimes(1)
    window.removeEventListener(OPEN_PALETTE_EVENT, seen)
  })

  test('mounted once, in the layout', () => {
    const layout = readFileSync(join(__dirname, '..', 'app', 'layout.tsx'), 'utf8')
    expect(layout).toMatch(/<Hotkeys \/>/)
    const walk = (d: string, out: string[] = []): string[] => {
      for (const e of readdirSync(d)) { const f = join(d, e); if (statSync(f).isDirectory()) walk(f, out); else if (/\.tsx$/.test(f)) out.push(f) }
      return out
    }
    const mounts = [...walk(join(__dirname, '..', 'app')), ...walk(join(__dirname, '..', 'components'))]
      .filter((f) => /<Hotkeys \/>/.test(readFileSync(f, 'utf8')))
    expect(mounts.length).toBe(1)
  })
})
