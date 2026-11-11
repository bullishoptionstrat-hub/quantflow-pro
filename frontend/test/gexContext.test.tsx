/**
 * GEX reference levels on the ticket: computed from the instrument's own
 * chain, labelled as delayed and modelled, and never a gate.
 *
 * The wall arithmetic is checked against the recorded `gex.json` — 446 real
 * SPY strikes from a live Cboe chain — with the expected answers worked out
 * from that file by hand and written into the test with their runners-up, so a
 * reader can see no tie was decided. The recording predates `asOf`, `spot` and
 * `rights`, so against it those read as unknown; the cases that need them are
 * built by hand on top of it in memory. The file itself is never edited.
 */
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  FUTURES_UNMEASURABLE, ageText, distanceText, etDateTime, gexChainFor, gexContext, maxOiStrike, netGexSign,
} from '@/lib/gexContext'
import type { GEXLevel, GEXResponse } from '@/lib/types'

const FIX = join(__dirname, '..', '..', 'backend', 'test', 'fixtures')
const recorded = (): GEXResponse => JSON.parse(readFileSync(join(FIX, 'gex.json'), 'utf8'))

const lvl = (strike: number, callOI: unknown, putOI: unknown): GEXLevel => ({
  strike, gex: 0, dex: 0, dexMissing: 0, callOI: callOI as number, putOI: putOI as number,
  callGamma: 0, putGamma: 0, callDelta: 0, putDelta: 0,
})

/** A minimal real-looking response around hand-built levels. */
const resp = (levels: GEXLevel[], o: Partial<GEXResponse> = {}): GEXResponse => ({
  symbol: 'SPY', levels, zeroDte: null, flipStrike: null,
  keyLevels: {
    gex: { maxStrike: null, max: null, minStrike: null, min: null },
    dex: { maxStrike: null, max: null, minStrike: null, min: null },
    totalGex: 1, totalDex: 1,
  },
  updatedAt: '2026-11-11T20:05:00.000Z', source: 'cboe', realData: true, realtime: false, delayedMinutes: 15,
  ...o,
})

describe('against the recorded SPY chain', () => {
  const ctx = gexContext(recorded())

  test('max call and put OI strikes, all expiries — hand-verified from gex.json', () => {
    // Call OI, largest four: 800 → 259,017; 790 → 158,191; 780 → 156,602; 775 → 143,920.
    expect(ctx.maxCallOi).toMatchObject({ strike: 800, oi: 259_017 })
    // Put OI, largest four: 500 → 390,824; 620 → 375,828; 480 → 350,897; 625 → 345,615.
    expect(ctx.maxPutOi).toMatchObject({ strike: 500, oi: 390_824 })
  })

  test('the same-day lens is computed from the lens, not the whole chain', () => {
    // zeroDte.expiry 2026-09-15, 94 contracts over 53 strikes.
    // Call OI: 764 → 8,872; 765 → 8,622. Put OI: 760 → 40,728; 742 → 16,025.
    expect(ctx.zeroDte).toMatchObject({
      status: 'PRESENT', expiry: '2026-09-15', contractCount: 94,
      maxCallOi: { strike: 764, oi: 8_872 }, maxPutOi: { strike: 760, oi: 40_728 },
    })
  })

  test('the net GEX sign is the sign of the published total', () => {
    // keyLevels.totalGex = -20,424,053,376.675182 (the sum of all 446 `gex`).
    expect(ctx.netGex).toEqual({ sign: 'NEGATIVE', total: -20424053376.675182 })
  })

  test('what the recording predates reads as unknown, not as a default', () => {
    expect(ctx.available).toBe(true)
    expect(ctx.spot).toBeNull()
    expect(ctx.maxCallOi?.distance).toBeNull()
    expect(ctx.asOfMs).toBeNull()
    expect(ctx.rights).toBeNull()
    expect(ctx.delayedMinutes).toBe(15)
    // The backend's own statement, verbatim. This recording carries the
    // sentence as it stood before 2026-11-11 ("short calls and short puts");
    // a current backend sends the corrected one. The panel renders whichever
    // it is sent rather than keeping a second copy.
    expect(ctx.assumption).toBe(recorded().assumptions?.dealerPositioning)
  })

  test('with the chain\'s own spot, distances are measured from it', () => {
    const c = gexContext({ ...recorded(), spot: 760, spotField: 'current_price' })
    expect(c.maxCallOi?.distance?.dollars).toBe(40)
    expect(c.maxCallOi?.distance?.pct).toBeCloseTo((40 / 760) * 100, 12)
    expect(c.maxPutOi?.distance?.dollars).toBe(-260)
    if (c.zeroDte.status !== 'PRESENT') throw new Error('lens expected')
    expect(c.zeroDte.maxPutOi?.distance?.dollars).toBe(0)
  })
})

describe('the tie rule: nearest spot, then the lower strike', () => {
  test('equal open interest goes to the strike nearest spot', () => {
    const levels = [lvl(95, 500, 0), lvl(104, 500, 0), lvl(110, 400, 0)]
    expect(maxOiStrike(levels, 'call', 102)?.strike).toBe(104)
    expect(maxOiStrike([...levels].reverse(), 'call', 102)?.strike).toBe(104)
  })

  test('equidistant from spot goes to the lower strike', () => {
    const levels = [lvl(105, 500, 0), lvl(95, 500, 0)]
    expect(maxOiStrike(levels, 'call', 100)?.strike).toBe(95)
  })

  test('with no spot, the lower strike', () => {
    const levels = [lvl(120, 0, 700), lvl(80, 0, 700)]
    expect(maxOiStrike(levels, 'put', null)?.strike).toBe(80)
  })

  test('a larger open interest wins regardless of distance', () => {
    expect(maxOiStrike([lvl(100, 10, 0), lvl(300, 11, 0)], 'call', 100)?.strike).toBe(300)
  })
})

describe('missing and empty', () => {
  test('a strike with no readable open interest is skipped, not read as zero', () => {
    const levels = [lvl(90, undefined, null), lvl(100, Number.NaN, 'x'), lvl(110, 3, 2)]
    expect(maxOiStrike(levels, 'call', 100)).toMatchObject({ strike: 110, oi: 3 })
    expect(maxOiStrike(levels, 'put', 100)).toMatchObject({ strike: 110, oi: 2 })
  })

  test('a side with no positive open interest has no level', () => {
    expect(maxOiStrike([lvl(100, 0, 5), lvl(105, undefined, 5)], 'call', 100)).toBeNull()
  })

  test('empty levels: nothing is available and nothing is computed', () => {
    const c = gexContext(resp([], { realData: false, source: null, unavailableReason: 'No Cboe chain has been received for SPY.' }))
    expect(c.available).toBe(false)
    expect(c.maxCallOi).toBeNull()
    expect(c.maxPutOi).toBeNull()
    expect(c.netGex.sign).toBe('UNKNOWN')
    expect(c.unavailableReason).toMatch(/No Cboe chain/)
  })

  test('a null, zero or negative spot is unknown, and so is every distance', () => {
    for (const spot of [null, 0, -5, Number.NaN, undefined]) {
      const c = gexContext(resp([lvl(100, 5, 5)], { spot: spot as number | null }))
      expect(c.spot).toBeNull()
      expect(c.maxCallOi?.distance).toBeNull()
    }
  })

  test('a null same-day lens says there is none; it never falls back to the nearest expiry', () => {
    const c = gexContext(resp([lvl(100, 5, 5)], { zeroDte: null }))
    expect(c.zeroDte).toEqual({ status: 'NONE' })
    const older = resp([lvl(100, 5, 5)])
    delete (older as Partial<GEXResponse>).zeroDte
    expect(gexContext(older).zeroDte).toEqual({ status: 'UNPUBLISHED' })
  })

  test('the net sign is the published total\'s, and unknown when there is none', () => {
    expect(netGexSign(3)).toBe('POSITIVE')
    expect(netGexSign(-3)).toBe('NEGATIVE')
    expect(netGexSign(0)).toBe('ZERO')
    expect(netGexSign(null)).toBe('UNKNOWN')
    expect(netGexSign(Number.NaN)).toBe('UNKNOWN')
    expect(netGexSign(undefined)).toBe('UNKNOWN')
  })
})

describe('which chain belongs to which instrument', () => {
  test('SPY and QQQ read their own chains', () => {
    expect(gexChainFor('SPY')).toEqual({ kind: 'CHAIN', chain: 'SPY' })
    expect(gexChainFor('QQQ')).toEqual({ kind: 'CHAIN', chain: 'QQQ' })
  })

  test('index futures are UNMEASURABLE — never the index\'s strikes shifted by a guess', () => {
    for (const s of ['ES', 'MES', 'NQ', 'MNQ']) {
      const c = gexChainFor(s)
      expect(c.kind).toBe('UNMEASURABLE')
      if (c.kind === 'UNMEASURABLE') expect(c.reason).toBe(FUTURES_UNMEASURABLE)
    }
  })

  test('metals and CUSTOM have no chain here', () => {
    for (const s of ['GC', 'MGC', 'SI', 'SIL', 'CUSTOM']) expect(gexChainFor(s).kind).toBe('NOT_APPLICABLE')
    expect(gexChainFor('')).toEqual({ kind: 'NONE' })
  })
})

describe('time and distance text', () => {
  test('the as-of is shown in New York time', () => {
    expect(etDateTime(Date.parse('2026-11-11T19:46:01.000Z'))).toBe('2026-11-11 14:46:01 ET')
    expect(etDateTime(Date.parse('2026-07-15T18:46:01.000Z'))).toBe('2026-07-15 14:46:01 ET')
  })

  test('age on this browser\'s clock, and a future stamp is not a negative age', () => {
    const t = Date.parse('2026-11-11T19:46:01.000Z')
    expect(ageText(t, t + 17 * 60_000 + 5_000)).toBe('17 min old')
    expect(ageText(t, t + 125 * 60_000)).toBe('2 h 05 min old')
    expect(ageText(t, t + 30_000)).toBe('under 1 min old')
    expect(ageText(t, t - 60_000)).toBe("ahead of this browser's clock")
  })

  test('distance is signed and measured from spot', () => {
    expect(distanceText({ dollars: 5, pct: 5 })).toBe('+$5.00 (+5.00%) from spot')
    expect(distanceText({ dollars: -260, pct: -34.2105 })).toBe('−$260.00 (−34.21%) from spot')
  })
})

// ─── The panel on /ticket ──────────────────────────────────────────────────

function mockApi(routes: Record<string, unknown>) {
  const calls: string[] = []
  vi.doMock('@/lib/apiFetch', () => ({
    apiFetch: vi.fn(async (path: string) => {
      calls.push(path)
      const key = Object.keys(routes).find((r) => path.startsWith(r))
      if (!key) return { ok: false, status: 404, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => routes[key] }
    }),
  }))
  return calls
}

beforeEach(() => vi.resetModules())
afterEach(() => vi.doUnmock('@/lib/apiFetch'))

/** The recording plus the fields a current backend adds, in memory. */
const live = (): GEXResponse => ({
  ...recorded(),
  asOf: '2026-09-15T19:46:01.000Z', asOfVendor: '2026-09-15T15:46:01',
  spot: 760, spotField: 'current_price',
  rights: { datasetId: 'CBOE_CDN_DELAYED_CHAIN', display: 'UNVERIFIED', mode: 'PRIVATE_RESEARCH' },
})

describe('the GEX panel', () => {
  test('SPY reads the SPY chain, and shows source, delay, ET as-of, age, rights and MODELLED', async () => {
    const calls = mockApi({ '/api/gex': live() })
    const { GexContextPanel } = await import('@/components/ticket/GexContextPanel')
    render(<GexContextPanel symbol="SPY" />)
    await waitFor(() => expect(screen.getByText('Max call OI strike (all expiries)')).toBeDefined())
    expect(calls).toEqual(['/api/gex?symbol=SPY'])
    const prov = screen.getByTestId('gex-provenance').textContent ?? ''
    expect(prov).toMatch(/Source CBOE/)
    expect(prov).toMatch(/DELAYED 15 MIN/)
    expect(prov).toMatch(/as of 2026-09-15 15:46:01 ET, .* on this browser's clock/)
    expect(prov).toMatch(/rights DISPLAY UNVERIFIED \(CBOE_CDN_DELAYED_CHAIN, PRIVATE_RESEARCH\)/)
    expect(prov).toMatch(/spot 760\.00 \(the chain's own current_price, not a live quote\)/)
    const panel = screen.getByTestId('gex-panel').textContent ?? ''
    expect(panel).toMatch(/CBOE · DELAYED · MODELLED/)
    expect(panel).toMatch(/Net GEX sign \(modelled\)NEGATIVE/)
    expect(panel).toMatch(/800 · OI 259,017 · \+\$40\.00/)
    expect(panel).toMatch(/Same-day \(0DTE\) max put OI strike · 2026-09-15760 · OI 40,728/)
  })

  test('against the recording, the as-of it lacks is said to be unknown, never filled in', async () => {
    mockApi({ '/api/gex': recorded() })
    const { GexContextPanel } = await import('@/components/ticket/GexContextPanel')
    render(<GexContextPanel symbol="SPY" />)
    await waitFor(() => expect(screen.getByTestId('gex-provenance')).toBeDefined())
    const prov = screen.getByTestId('gex-provenance').textContent ?? ''
    // The recording predates the fields, so the backend did not publish them.
    // That is a different fact from a chain that carried no time, and the
    // panel must not claim the latter.
    expect(prov).toMatch(/as of unknown — this backend does not publish the chain's as-of/)
    expect(prov).not.toMatch(/the chain carried no readable time/)
    expect(prov).toMatch(/spot not published by this backend/)
    expect(prov).toMatch(/rights class not published/)
    expect(screen.getByTestId('gex-panel').textContent).toMatch(/distance not computed: this backend does not publish the chain's spot/)
    expect(screen.getByTestId('gex-panel').textContent).toMatch(/MODELLED/)
  })

  test('a chain that carried no time, or no spot, is said to have carried none', async () => {
    mockApi({ '/api/gex': { ...live(), asOf: null, asOfVendor: null, spot: null, spotField: null } })
    const { GexContextPanel } = await import('@/components/ticket/GexContextPanel')
    render(<GexContextPanel symbol="SPY" />)
    await waitFor(() => expect(screen.getByTestId('gex-provenance')).toBeDefined())
    const prov = screen.getByTestId('gex-provenance').textContent ?? ''
    expect(prov).toMatch(/as of unknown — the chain carried no readable time/)
    expect(prov).toMatch(/spot unknown — the chain carried none/)
    expect(screen.getByTestId('gex-panel').textContent).toMatch(/distance not computed: the chain carried no spot/)
  })

  test('ES says UNMEASURABLE and reads no chain at all', async () => {
    const calls = mockApi({ '/api/gex': live() })
    const { GexContextPanel } = await import('@/components/ticket/GexContextPanel')
    render(<GexContextPanel symbol="ES" />)
    expect(screen.getByTestId('gex-unmeasurable').textContent).toMatch(FUTURES_UNMEASURABLE)
    await new Promise((r) => setTimeout(r, 20))
    expect(calls).toEqual([])
    expect(screen.queryByText(/Max call OI strike/)).toBeNull()
  })

  test('no chain on the backend is an honest empty state, with its reason', async () => {
    mockApi({ '/api/gex': resp([], { realData: false, source: null, unavailableReason: 'No Cboe chain has been received for QQQ.' }) })
    const { GexContextPanel } = await import('@/components/ticket/GexContextPanel')
    render(<GexContextPanel symbol="QQQ" />)
    await waitFor(() => expect(screen.getByTestId('gex-empty').textContent).toMatch(/No Cboe chain has been received for QQQ/))
    expect(screen.queryByText(/Max call OI strike/)).toBeNull()
  })

  test('nothing in the panel is coloured as a pass or a fail', () => {
    const src = readFileSync(join(__dirname, '..', 'components', 'ticket', 'GexContextPanel.tsx'), 'utf8')
    for (const banned of ['#22c55e', '#ef4444', '--bullish', '--bearish', '34,197,94', '239,68,68']) {
      expect(src).not.toContain(banned)
    }
  })
})
