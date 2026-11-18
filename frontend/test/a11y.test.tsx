/**
 * Accessibility floor for every page under `app/`, rendered in jsdom with the
 * backend unreachable (the state every page must already handle). The page
 * list is read from the directory, not written here, so a new page is in
 * scope the moment it exists.
 *
 * Checked on the rendered DOM:
 * - every form control (input, select, textarea) has an accessible name:
 *   `aria-label`, `aria-labelledby`, a `<label for>`, or a wrapping `<label>`;
 * - every button has a name (text, `aria-label` or `title`);
 * - no positive `tabIndex` (it reorders focus away from reading order);
 * - the page has at least one heading, so a screen-reader user can find it.
 * And on the layout: a skip link to `<main id="main">`, which is focusable.
 */
import { describe, expect, test, vi } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  redirect: vi.fn(),
}))
vi.mock('@/lib/apiFetch', () => ({
  apiFetch: vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' })),
}))
vi.mock('@/lib/socket', () => {
  const s = { on: vi.fn(), off: vi.fn(), emit: vi.fn(), connected: false, connect: vi.fn(), disconnect: vi.fn(), io: { on: vi.fn(), off: vi.fn() } }
  return { getSocket: () => s, disconnectSocket: vi.fn() }
})

const APP = join(__dirname, '..', 'app')
function pages(d = APP, out: string[] = []): string[] {
  for (const n of readdirSync(d)) {
    const p = join(d, n)
    if (statSync(p).isDirectory()) pages(p, out)
    else if (n === 'page.tsx') out.push(p)
  }
  return out.sort()
}

function nameOf(el: Element): string {
  const aria = el.getAttribute('aria-label')?.trim()
  if (aria) return aria
  const by = el.getAttribute('aria-labelledby')
  if (by) return by.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '').join(' ').trim()
  const id = el.getAttribute('id')
  if (id) {
    const l = el.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`)
    if (l?.textContent?.trim()) return l.textContent.trim()
  }
  const wrap = el.closest('label')
  if (wrap?.textContent?.trim()) return wrap.textContent.trim()
  if (el.tagName === 'BUTTON') return (el.textContent?.trim() || el.getAttribute('title')?.trim() || '')
  return el.getAttribute('title')?.trim() ?? ''
}

const PAGES = pages()

describe('every page meets the accessibility floor', () => {
  test('the walk found the pages', () => {
    expect(PAGES.length).toBeGreaterThanOrEqual(20)
  })
  for (const file of PAGES) {
    const rel = relative(APP, file)
    test(rel, async () => {
      const mod = await import(/* @vite-ignore */ file)
      const Page = mod.default as React.ComponentType
      const { container } = render(<Page />)
      await new Promise((r) => setTimeout(r, 0))
      // A page whose whole body is a redirect renders nothing to check.
      if (/redirect\(/.test(readFileSync(file, 'utf8')) && container.innerHTML === '') { cleanup(); return }
      const unnamed = Array.from(container.querySelectorAll('input:not([type=hidden]), select, textarea, button'))
        .filter((el) => !nameOf(el))
        .map((el) => el.outerHTML.slice(0, 120))
      expect(unnamed, `${rel}: controls with no accessible name\n${unnamed.join("\n")}`).toEqual([])
      const positive = Array.from(container.querySelectorAll('[tabindex]')).filter((el) => Number(el.getAttribute('tabindex')) > 0)
      expect(positive.length, `${rel}: positive tabIndex`).toBe(0)
      expect(container.querySelector('h1, h2, h3, [role=heading]'), `${rel}: no heading`).not.toBeNull()
      cleanup()
    })
  }
})

describe('layout landmarks', () => {
  const src = readFileSync(join(APP, 'layout.tsx'), 'utf8')
  test('a skip link is the first focusable element and targets a focusable main', () => {
    expect(src).toMatch(/<a href="#main" className="skip-link"/)
    expect(src).toMatch(/<main id="main" tabIndex=\{-1\}/)
    expect(src.indexOf('skip-link')).toBeLessThan(src.indexOf('<Sidebar'))
    expect(readFileSync(join(APP, 'globals.css'), 'utf8')).toMatch(/\.skip-link:focus/)
  })
  test('the footer is a contentinfo landmark and the sidebar is labelled', () => {
    expect(src).toMatch(/<footer/)
    expect(readFileSync(join(__dirname, '..', 'components', 'layout', 'Sidebar.tsx'), 'utf8')).toMatch(/<aside[^>]*aria-label=/)
  })
})

describe('status changes are announced', () => {
  const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')
  test('verdicts, errors and the feed connection sit in live regions', () => {
    expect(read('app/ticket/page.tsx')).toMatch(/title="Verdict"[^>]*aria-live="polite"/)
    expect(read('app/risk/page.tsx')).toMatch(/title="Size result"[^>]*aria-live="polite"/)
    expect(read('app/journal/page.tsx')).toMatch(/data-testid="journal-error" role="alert"/)
    const prep = read('app/prep/page.tsx')
    expect(prep).toMatch(/data-testid="plan-error" role="alert"/)
    expect(prep).toMatch(/data-testid="plan-errors" role="alert"/)
    expect(prep).toMatch(/data-testid="plan-saved-status" role="status"/)
    expect(read('components/layout/Sidebar.tsx')).toMatch(/<span role="status"[^>]*>\s*\{connected \? '● FEED CONNECTED'/)
  })
})

describe('controls that only exist after input', () => {
  test('a strategy leg added after a spot is entered has named controls', async () => {
    const { StrategyBuilder } = await import('@/components/calculator/StrategyBuilder')
    const { container } = render(<StrategyBuilder />)
    fireEvent.change(screen.getByLabelText('Spot price'), { target: { value: '600' } })
    fireEvent.click(screen.getByText(/\+ Add Leg/))
    expect(container.querySelector('input[type=range][max="200"]')).not.toBeNull()
    const unnamed = Array.from(container.querySelectorAll('input:not([type=hidden]), select, textarea, button'))
      .filter((el) => !nameOf(el)).map((el) => el.outerHTML.slice(0, 120))
    expect(unnamed, unnamed.join("\n")).toEqual([])
  })
})
