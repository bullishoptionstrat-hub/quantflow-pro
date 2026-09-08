/**
 * Three status indicators that asserted more than they had checked.
 *
 *   - The sidebar's `● LIVE DATA` / `◌ SIMULATION` was driven by `connected`,
 *     the socket's transport state. A keyless deployment's backend simulates
 *     prints and sends them down a perfectly healthy socket, so it said LIVE
 *     DATA over a simulated tape; and nothing in the browser simulates
 *     anything since `generateSeedFlow` was deleted, so a dead socket said
 *     SIMULATION while no data existed at all. One flag, two questions.
 *   - `MARKET OPEN`, over a weekday-and-clock check with no holiday calendar:
 *     a green dot on Thanksgiving.
 *   - The heat map's "across all tickers · sorted by total flow" over a
 *     500-signal session window, and "premium-weighted heat" over a number
 *     that is `Math.max`.
 */
import { describe, expect, test, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// `usePathname()` has no router outside an App Router route; the sidebar reads
// it to mark the active link.
vi.mock('next/navigation', () => ({ usePathname: () => '/flow' }))
import HeatMapPage from '@/app/heat-map/page'
import { Sidebar } from '@/components/layout/Sidebar'
import { useStore } from '@/store/useStore'
import { isRegularHours } from '@/lib/utils'
import type { FlowEvent } from '@/lib/types'

const flow = (o: Partial<FlowEvent> = {}): FlowEvent => ({
  id: `e${Math.random()}`, underlying: 'SPY', option_type: 'C', order_type: 'SWEEP',
  strike: 610, expiry: '2026-10-16', total_premium: 500_000, total_size: 100,
  heat_score: 60, sentiment: 'BULLISH', is_unusual: false, synthetic: false,
  created_at: new Date().toISOString(), ...o,
} as FlowEvent)

beforeEach(() => {
  useStore.setState({ flowEvents: [], powerAlerts: [], connected: false } as never)
})

describe('the sidebar reports transport as transport', () => {
  test('a connected socket is not a claim about the data', () => {
    // It said LIVE DATA, which a keyless backend's simulated prints do not
    // make true.
    useStore.setState({ connected: true } as never)
    const { container } = render(<Sidebar />)
    expect(container.textContent).toMatch(/FEED CONNECTED/)
    expect(container.textContent).not.toMatch(/LIVE DATA/)
  })

  test('a dead socket does not claim a simulation is running', () => {
    // Nothing in the browser simulates anything any more.
    const { container } = render(<Sidebar />)
    expect(container.textContent).toMatch(/FEED DISCONNECTED/)
    expect(container.textContent).not.toMatch(/SIMULATION/)
  })

  // "CONSTRUCTED", not "SIMULATED". `synthetic` is set on generated prints and
  // on real vendor chain rows synthesized from a day's aggregate volume, so a
  // deployment credentialed for only chain sources — Schwab, Tastytrade — was
  // told ALL SIGNALS SIMULATED about a working paid feed. The flow table's own
  // badge has always worded it accurately ("constructed from aggregate volume
  // or generated"); that wording is now the only one on any surface. Demo mode
  // keeps its separate all-or-nothing banner, so nothing is lost.
  test('constructed prints are reported where they are, per print', () => {
    useStore.setState({ connected: true, flowEvents: [flow({ synthetic: true }), flow()] } as never)
    const { container } = render(<Sidebar />)
    expect(container.textContent).toMatch(/1\/2 CONSTRUCTED/)
    expect(container.textContent).not.toMatch(/SIMULATED/)
  })

  test('a feed of nothing but constructed prints says so plainly', () => {
    useStore.setState({ connected: true, flowEvents: [flow({ synthetic: true })] } as never)
    const { container } = render(<Sidebar />)
    expect(container.textContent).toMatch(/ALL SIGNALS CONSTRUCTED/)
  })

  test('a fully observed feed stays quiet about it', () => {
    useStore.setState({ connected: true, flowEvents: [flow(), flow()] } as never)
    const { container } = render(<Sidebar />)
    expect(container.textContent).not.toMatch(/CONSTRUCTED|SIMULATED/)
  })

  test('no surface keyed on `synthetic` calls it simulated', () => {
    // Six surfaces said "simulated" or wore a 🧪 flask about a flag that is
    // also set on real Schwab, Tastytrade, marketData and Yahoo chain rows.
    // The row badge did not, which is how the discrepancy was findable at all.
    // A hand-fixed list of six is exactly the shape of guard this repo has
    // twice found insufficient, so this reads the source instead.
    //
    // `app/dark-pool/page.tsx` is excluded on purpose: it branches on
    // `p.source === 'simulation'`, which really is generated data, and
    // "SIMULATED" there is the correct word.
    const ROOT = join(__dirname, '..')
    const files: string[] = []
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        if (n === 'node_modules' || n === '.next' || n === 'test') continue
        const p = join(d, n)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.tsx?$/.test(n)) files.push(p)
      }
    }
    // Every source directory, discovered — not ['app', 'components', 'lib'],
    // which is what this guard said first and which missed `hooks/`, where
    // the *desktop notification* announced a real Schwab feed as
    // "🧪 SIMULATED". A hand-listed scope is the exact failure this repo has
    // now found three times.
    for (const d of readdirSync(ROOT)) {
      if (['node_modules', '.next', 'test', 'public'].includes(d)) continue
      const p = join(ROOT, d)
      if (statSync(p).isDirectory()) walk(p)
    }

    const offenders: string[] = []
    for (const f of files) {
      const rel = f.slice(ROOT.length + 1)
      if (rel === 'app/dark-pool/page.tsx') continue
      const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|\{\/\*[\s\S]*?\*\/\}/g, '')
      if (!/\bsynthetic\b/.test(src)) continue
      if (/🧪/.test(src)) offenders.push(`${rel}: flask emoji`)
      if (/simulated|SIMULATED/.test(src)) offenders.push(`${rel}: the word "simulated"`)
    }
    expect(offenders).toEqual([])
  })

  test('the session indicator claims only what it checks', () => {
    // No holiday calendar exists here, so "MARKET OPEN" was an assertion the
    // code could not support.
    const { container } = render(<Sidebar />)
    expect(container.textContent).toMatch(isRegularHours() ? /REGULAR HOURS/ : /OUTSIDE HOURS/)
    expect(container.textContent).not.toMatch(/MARKET OPEN|MARKET CLOSED/)
  })

  test('no static LIVE pill contradicts the connection dot', () => {
    // The pill was driven by `isMarketOpen()`, so it read LIVE on any weekday
    // afternoon whether or not a signal had arrived.
    const { container } = render(<Sidebar />)
    expect(container.textContent).not.toMatch(/\bOFF\b/)
  })
})

describe('the heat map describes its own window', () => {
  test('it does not say all tickers or total flow', () => {
    useStore.setState({ connected: true, flowEvents: [flow(), flow({ underlying: 'NVDA' })] } as never)
    const { container } = render(<HeatMapPage />)
    expect(container.textContent).not.toMatch(/all tickers/i)
    expect(container.textContent).not.toMatch(/TOTAL PREMIUM/)
    expect(container.textContent).toMatch(/over the 2 signals received this session/)
  })

  test('the headline number is named for what it is', () => {
    // `Math.max` of the ticker's heats — the loudest single print, described
    // as "premium-weighted heat".
    useStore.setState({ connected: true, flowEvents: [flow({ heat_score: 40 }), flow({ heat_score: 90 })] } as never)
    const { container } = render(<HeatMapPage />)
    expect(container.textContent).not.toMatch(/Premium-weighted heat/i)
    expect(container.textContent).toMatch(/PEAK HEAT/)
    expect(screen.getAllByText('90').length).toBeGreaterThan(0)
  })

  test('a tile built from constructed prints is marked', () => {
    useStore.setState({ connected: true, flowEvents: [flow({ synthetic: true })] } as never)
    const { container } = render(<HeatMapPage />)
    expect(container.textContent).toMatch(/SYN/)
    expect(container.textContent).toMatch(/1 constructed/)
  })

  test('a fully observed map carries no marker', () => {
    useStore.setState({ connected: true, flowEvents: [flow()] } as never)
    const { container } = render(<HeatMapPage />)
    expect(container.textContent).not.toMatch(/SYN|constructed|simulated|🧪/)
  })
})
