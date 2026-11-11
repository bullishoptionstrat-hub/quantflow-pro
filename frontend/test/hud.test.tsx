/**
 * The Desk HUD: a visual system, a status strip and a command palette.
 *
 * It is chrome, and the rule for chrome here is the rule for data: nothing on
 * screen may claim more than the terminal established. So these tests are
 * mostly about what the new surfaces must NOT do — print a number nobody
 * measured, print the session as "the market", keep a second page list, or
 * paint text the eye cannot read.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, within } from '@testing-library/react'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { MarketSession, SessionPoll } from '@/lib/marketSession'

const push = vi.fn()
vi.mock('next/navigation', () => ({ usePathname: () => '/flow', useRouter: () => ({ push }) }))

// The strip's session comes from the shared poll; drive it directly.
const SESSION = vi.hoisted(() => ({ value: null as unknown }))
vi.mock('@/lib/marketSession', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/marketSession')>()
  return { ...orig, useMarketSession: () => SESSION.value as SessionPoll }
})
vi.mock('@/lib/apiFetch', () => ({
  apiFetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ quotes: [] }) })),
}))

import { CommandPalette } from '@/components/hud/CommandPalette'
import { StatusStrip, zoneClock } from '@/components/hud/StatusStrip'
import { Panel } from '@/components/hud/Panel'
import { Sidebar } from '@/components/layout/Sidebar'
import { TopBar } from '@/components/layout/TopBar'
import { NAV, fuzzyScore, rankNav } from '@/lib/nav'
import { describeSession } from '@/lib/marketSession'
import { useStore } from '@/store/useStore'
import type { FlowEvent } from '@/lib/types'

const ROOT = join(__dirname, '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')
const code = (rel: string) => read(rel).replace(/\{\/\*[\s\S]*?\*\/\}|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')

const loading: SessionPoll = { panel: { status: 'loading' }, sources: { status: 'loading' } }
const session = (o: Partial<MarketSession>): MarketSession => ({
  state: 'OPEN', date: '2026-11-11', nowMinutesEt: 10 * 60, openMinutesEt: 9 * 60 + 30,
  closeMinutesEt: 16 * 60, basis: '2026-11-11 is a regular session', source: 'NYSE/Cboe published holiday schedules',
  readAt: '2026-11-01', coverage: { from: '2026-01-01', to: '2027-12-31' }, ...o,
})
const okSession = (s: MarketSession | null): SessionPoll => ({ panel: { status: 'ok', data: s }, sources: { status: 'loading' } })

const flow = (o: Partial<FlowEvent> = {}): FlowEvent => ({
  id: `e${Math.random()}`, underlying: 'SPY', option_type: 'C', order_type: 'SWEEP',
  strike: 610, expiry: '2026-12-18', total_premium: 500_000, total_size: 100,
  heat_score: 60, sentiment: 'BULLISH', is_unusual: false, synthetic: false,
  created_at: new Date().toISOString(), ...o,
} as FlowEvent)

beforeEach(() => {
  push.mockClear()
  SESSION.value = loading
  useStore.setState({ flowEvents: [], powerAlerts: [], connected: false } as never)
})
afterEach(() => vi.useRealTimers())

// ─── The page list ──────────────────────────────────────────────────────────

describe('one page list', () => {
  const pageDirs = (() => {
    const out: string[] = []
    const walk = (d: string, segs: string[]) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n)
        if (!statSync(p).isDirectory()) continue
        // Route groups like `(auth)` add no URL segment.
        const next = n.startsWith('(') ? segs : [...segs, n]
        if (existsSync(join(p, 'page.tsx'))) out.push(`/${next.join('/')}`)
        walk(p, next)
      }
    }
    walk(join(ROOT, 'app'), [])
    return out
  })()

  test('every page in NAV exists, and every page except sign-in is in NAV', () => {
    for (const n of NAV) expect(pageDirs, `${n.href} has no app/**/page.tsx`).toContain(n.href)
    const unlisted = pageDirs.filter((p) => !['/login', '/register'].includes(p) && !NAV.some((n) => n.href === p))
    expect(unlisted).toEqual([])
  })

  test('every page in NAV is behind the middleware', () => {
    const mw = read('middleware.ts')
    for (const n of NAV) expect(mw, `${n.href} is not in the matcher`).toContain(`'${n.href}/:path*'`)
  })

  test('the sidebar, the mobile bar and the palette read it rather than keep their own', () => {
    for (const f of ['components/layout/Sidebar.tsx', 'components/layout/MobileNav.tsx', 'components/hud/CommandPalette.tsx']) {
      const src = code(f)
      expect(src, f).toMatch(/from '@\/lib\/nav'/)
      expect(src, `${f} holds its own page list`).not.toMatch(/href:\s*'\//)
    }
  })

  test('the sidebar draws exactly NAV, in order, and marks the current page', () => {
    const { container } = render(<Sidebar />)
    const links = Array.from(container.querySelectorAll('nav a')).map((a) => a.getAttribute('href'))
    expect(links).toEqual(NAV.map((n) => n.href))
    expect(container.querySelector('a[aria-current="page"]')?.getAttribute('href')).toBe('/flow')
  })

  test('no menu entry calls the tape live', () => {
    for (const n of NAV) expect(n.label).not.toMatch(/\blive\b|real-time/i)
  })
})

describe('fuzzyScore', () => {
  test('a prefix beats a word start beats a substring beats scattered letters', () => {
    const prefix = fuzzyScore('tra', 'Trade Ticket')!
    const word = fuzzyScore('tic', 'Trade Ticket')!
    const inside = fuzzyScore('ade', 'Trade Ticket')!
    const scattered = fuzzyScore('ttk', 'Trade Ticket')!
    expect(prefix).toBeGreaterThan(word)
    expect(word).toBeGreaterThan(inside)
    expect(inside).toBeGreaterThan(scattered)
    expect(scattered).toBeGreaterThan(0)
  })

  test('letters out of order, or absent, do not match', () => {
    expect(fuzzyScore('xyz', 'Trade Ticket')).toBeNull()
    expect(fuzzyScore('kt', 'Trade Ticket')).not.toBeNull()
    expect(fuzzyScore('zt', 'Trade Ticket')).toBeNull()
  })

  test('an empty query keeps the list as it is', () => {
    expect(rankNav('').map((n) => n.href)).toEqual(NAV.map((n) => n.href))
  })
})

// ─── The command palette ────────────────────────────────────────────────────

describe('the command palette', () => {
  const open = (init: KeyboardEventInit = { key: 'k', ctrlKey: true }) => fireEvent.keyDown(window, init)
  const options = () => screen.getAllByRole('option').map((o) => o.getAttribute('data-href'))

  test('renders nothing until asked', () => {
    render(<CommandPalette />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('option')).toBeNull()
  })

  test('Ctrl+K and ⌘K open it on the whole page list, in order', () => {
    render(<CommandPalette />)
    open()
    expect(screen.getByRole('dialog', { name: 'Jump to page' })).toBeTruthy()
    expect(options()).toEqual(NAV.map((n) => n.href))
    open()   // the same chord closes it
    expect(screen.queryByRole('dialog')).toBeNull()
    open({ key: 'K', metaKey: true })
    expect(options()).toEqual(NAV.map((n) => n.href))
  })

  test('the strip button opens it too', () => {
    render(<><StatusStrip /><CommandPalette /></>)
    fireEvent.click(screen.getByRole('button', { name: /JUMP/ }))
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  test('typing narrows it, and Enter goes to the best match', () => {
    render(<CommandPalette />)
    open()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'jour' } })
    expect(options()[0]).toBe('/journal')
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
    expect(push).toHaveBeenCalledWith('/journal')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('arrows move the selection and wrap', () => {
    render(<CommandPalette />)
    open()
    const box = screen.getByRole('combobox')
    fireEvent.keyDown(box, { key: 'ArrowUp' })   // from the top, wraps to the last
    expect(screen.getAllByRole('option').at(-1)!.getAttribute('aria-selected')).toBe('true')
    expect(box.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option').at(-1)!.id)
    fireEvent.keyDown(box, { key: 'ArrowDown' })  // and back round to the first
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(push).toHaveBeenCalledWith(NAV[1]!.href)
  })

  test('a query that matches nothing says so', () => {
    render(<CommandPalette />)
    open()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'qqqzzz' } })
    expect(screen.queryByRole('option')).toBeNull()
    expect(screen.getByRole('status').textContent).toMatch(/No page matches/)
  })

  test('Escape closes it and focus goes back where it was', () => {
    render(<><button type="button">opener</button><CommandPalette /></>)
    const opener = screen.getByRole('button', { name: 'opener' })
    opener.focus()
    open()
    expect(document.activeElement).toBe(screen.getByRole('combobox'))
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  test('Tab does not leave the dialog', () => {
    // jsdom does not move focus on Tab, so this asserts the handler holds it;
    // the real Tab key is checked in a browser before merge.
    render(<><button type="button">outside</button><CommandPalette /></>)
    open()
    const box = screen.getByRole('combobox')
    expect(fireEvent.keyDown(box, { key: 'Tab' })).toBe(false)
    expect(fireEvent.keyDown(box, { key: 'Tab', shiftKey: true })).toBe(false)
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
  })
})

// ─── The status strip ───────────────────────────────────────────────────────

describe('the status strip', () => {
  test('the clocks are the three zones they name, and tick', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-11T15:04:05Z'))
    const { container } = render(<StatusStrip />)
    const clocks = () => Array.from(container.querySelectorAll('.hud-strip__clock')).map((c) => c.textContent)
    expect(clocks()).toEqual(['NY10:04:05', 'LDN15:04:05', 'TYO00:04:05'])
    act(() => { vi.advanceTimersByTime(1000) })
    expect(clocks()).toEqual(['NY10:04:06', 'LDN15:04:06', 'TYO00:04:06'])
    // Summer time is the zone's business, not ours: 15:04Z in July.
    expect(zoneClock(new Date('2026-07-01T15:04:05Z'), 'America/New_York')).toBe('11:04:05')
    expect(zoneClock(new Date('2026-07-01T15:04:05Z'), 'Europe/London')).toBe('16:04:05')
    const src = code('components/hud/StatusStrip.tsx')
    for (const tz of ['America/New_York', 'Europe/London', 'Asia/Tokyo']) expect(src).toContain(`timeZone: '${tz}'`)
  })

  test('the session words are describeSession\'s, and the clocks say none', () => {
    for (const s of [session({}), session({ state: 'CLOSED_WEEKEND' }), session({ state: 'UNKNOWN' }), null]) {
      SESSION.value = okSession(s)
      const { container, unmount } = render(<StatusStrip />)
      const expected = describeSession(s)
      expect(screen.getByTestId('hud-session').textContent).toBe(expected.label)
      expect(screen.getByTestId('hud-session').getAttribute('title')).toBe(expected.detail)
      expect(screen.getByTestId('hud-clocks').textContent).not.toMatch(/OPEN|CLOSED|RTH|SESSION|MARKET/)
      expect(container.textContent).not.toMatch(/MARKET OPEN|MARKET CLOSED/)
      unmount()
    }
    // Before the backend answers it says it cannot say.
    SESSION.value = loading
    render(<StatusStrip />)
    expect(screen.getByTestId('hud-session').textContent).toBe('SESSION UNKNOWN')
  })

  test('no session word is written in the strip itself', () => {
    // Every word about the session comes through describeSession, the one
    // place that knows the verdict is RTH and nothing wider.
    const src = code('components/hud/StatusStrip.tsx')
    expect(src).not.toMatch(/OPEN|CLOSED|MARKET/)
    expect(src).toMatch(/describeSession\(/)
    expect(src).toMatch(/SESSION_TONE\[/)
  })

  test('it prints no number nobody measured', () => {
    // Before anything has reported there is nothing to count, so outside the
    // clocks there must be no digit at all. That catches any invented figure,
    // not only the ones a word list would think of.
    const { container } = render(<StatusStrip />)
    const clocks = screen.getByTestId('hud-clocks').textContent ?? ''
    const rest = (container.textContent ?? '').replace(clocks, '')
    expect(rest).not.toMatch(/\d/)

    const banned = /\blatency\b|\bping\b|\buptime\b|\bthroughput\b|\d\s*ms\b|\bp&l\b|\bpnl\b|\brtt\b/i
    expect(container.textContent).not.toMatch(banned)
    expect(code('components/hud/StatusStrip.tsx')).not.toMatch(banned)

    // And with everything reporting, still none of those words.
    useStore.setState({ connected: true, flowEvents: [flow({ synthetic: true }), flow()] } as never)
    SESSION.value = { panel: { status: 'ok', data: session({}) }, sources: { status: 'ok', data: {
      byState: { connected: ['cboe'], degraded: [], error: ['stooq'], refused: [], disabled: [], unknown: [] }, simulation: true,
    } } } as SessionPoll
    const again = render(<StatusStrip />).container
    expect(again.textContent).not.toMatch(banned)
  })

  test('feed and constructed share say what the sidebar says', () => {
    const { unmount } = render(<StatusStrip />)
    expect(screen.getByTestId('hud-feed').textContent).toBe('FEED DISCONNECTED')
    expect(screen.queryByTestId('hud-constructed')).toBeNull()
    unmount()

    useStore.setState({ connected: true, flowEvents: [flow({ synthetic: true }), flow()] } as never)
    const strip = render(<StatusStrip />).container
    expect(within(strip).getByTestId('hud-feed').textContent).toBe('FEED CONNECTED')
    expect(within(strip).getByTestId('hud-constructed').textContent).toBe('SYN · 1/2 CONSTRUCTED')
    expect(strip.textContent).not.toMatch(/SIMULATED|LIVE/)
  })
})

// ─── Panels ────────────────────────────────────────────────────────────────

describe('panels', () => {
  test('a panel is a region named by its title', () => {
    render(<Panel title="Size result" code="BROWSER CALC"><p>body</p></Panel>)
    const region = screen.getByRole('region', { name: 'Size result' })
    expect(within(region).getByText('BROWSER CALC')).toBeTruthy()
    expect(within(region).getByText('body')).toBeTruthy()
  })

  test('a provenance tag is never a serial number', () => {
    // `code` says where the numbers come from. A tag like `RSK-01` would be a
    // number on screen that measures nothing.
    const used: string[] = []
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.tsx$/.test(n)) {
          for (const m of Array.from(readFileSync(p, 'utf8').matchAll(/<Panel[^>]*?\scode="([^"]*)"/g))) used.push(m[1]!)
        }
      }
    }
    walk(join(ROOT, 'app'))
    walk(join(ROOT, 'components'))
    expect(used.length).toBeGreaterThan(0)
    for (const c of used) expect(c, c).not.toMatch(/\d/)
  })
})

// ─── Labels that claimed more than the data ─────────────────────────────────

describe('labels say what they are over', () => {
  test('the tape\'s premium names its window, and is not shown over nothing', async () => {
    const empty = render(<TopBar />)
    await act(async () => {})
    expect(empty.container.textContent).not.toMatch(/PREM/)
    empty.unmount()

    useStore.setState({ flowEvents: [flow(), flow({ total_premium: 1_500_000 })] } as never)
    render(<TopBar />)
    await act(async () => {})   // let the tape's fetch settle
    const prem = screen.getByTestId('topbar-prem')
    expect(prem.textContent).toBe('PREM · 2 SIG $2.0M')
    expect(prem.getAttribute('title')).toMatch(/last 2 signals this browser received/)
    expect(document.body.textContent).not.toMatch(/TOTAL PREM/)
  })

  test('no surface calls a window a total, or the tape live, or the scoring AI', () => {
    expect(code('components/layout/TopBar.tsx')).not.toMatch(/TOTAL PREM/)
    const watch = code('app/watchlist/page.tsx')
    expect(watch).not.toMatch(/TOTAL PREM/)
    expect(watch).not.toMatch(/>TRADES</)
    for (const f of ['components/flow/FlowFeed.tsx', 'app/flow/page.tsx']) {
      expect(code(f), f).not.toMatch(/\bLIVE\b|Live Options|real-time/i)
    }
    const layout = code('app/layout.tsx')
    const description = layout.match(/name="description" content="([^"]*)"/)?.[1] ?? ''
    expect(description).not.toBe('')
    expect(description).not.toMatch(/\bAI\b|real-time/i)
    expect(code('app/gex/page.tsx')).not.toMatch(/Dealer Gamma Exposure|Support & Resistance|Gamma Flip Point/)
    expect(code('components/gex/GEXChart.tsx')).not.toMatch(/NET DEALER GAMMA/)
    expect(code('app/settings/page.tsx')).not.toMatch(/'✓ LIVE'/)
  })
})

// ─── Tokens ────────────────────────────────────────────────────────────────

describe('tokens', () => {
  const css = read('app/globals.css').replace(/\/\*[\s\S]*?\*\//g, '')
  const root = css.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
  const vars = Object.fromEntries(Array.from(root.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)).map((m) => [m[1]!, m[2]!]))

  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [number, number, number]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
    return (hi + 0.05) / (lo + 0.05)
  }

  test('every text colour is at least 4.5:1 on every surface', () => {
    // --text-muted was #52525b: about 2.6:1 on the old background, under every
    // "as of", caption and column header in the app.
    const texts = ['text-primary', 'text-secondary', 'text-muted', 'accent-cyan', 'brand', 'warn', 'bullish', 'bearish']
    const surfaces = ['bg-primary', 'bg-secondary', 'bg-card', 'bg-elevated']
    const failing: string[] = []
    for (const t of texts) {
      for (const s of surfaces) {
        expect(vars[t], `--${t} is a hex colour in :root`).toMatch(/^#/)
        expect(vars[s], `--${s} is a hex colour in :root`).toMatch(/^#/)
        const c = contrast(vars[t]!, vars[s]!)
        if (c < 4.5) failing.push(`--${t} on --${s}: ${c.toFixed(2)}:1`)
      }
    }
    expect(failing).toEqual([])
  })

  test('the arithmetic is the WCAG one', () => {
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 5)
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 1)
  })

  test('motion stops for people who ask, and focus is always visible', () => {
    const reduced = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(reduced).toMatch(/\.skeleton\s*\{\s*animation:\s*none/)
    expect(reduced).toMatch(/animation-duration/)
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:[^;]*!important/)
  })

  test('nothing in the chrome blinks on a timer', () => {
    // A pulsing "live" dot is a claim made by animation. The stylesheet
    // defines two animations: the loading skeleton's shimmer and the
    // palette's one-shot fade-in. Only the skeleton repeats.
    const frames = Array.from(css.matchAll(/@keyframes\s+([\w-]+)/g)).map((m) => m[1]).sort()
    expect(frames).toEqual(['palette-in', 'shimmer'])
    const infinite = Array.from(css.matchAll(/([^{}]+)\{[^}]*animation:[^;]*infinite/g)).map((m) => m[1]!.trim())
    expect(infinite).toEqual(['.skeleton'])
  })
})
