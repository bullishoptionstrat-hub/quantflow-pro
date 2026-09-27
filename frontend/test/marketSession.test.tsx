/**
 * The sidebar reads the published session verdict instead of guessing it.
 *
 * `isRegularHours()` was a weekday test and a hardcoded 09:30–16:00 window,
 * computed in the browser. Its own docstring admitted Thanksgiving read as open
 * and a half-day read as open past its 13:00 close. The calendar is maintained
 * in the backend and `/api/health` now carries the verdict; these are the four
 * things the renderer must get right about it.
 */
import { describe, test, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describeSession, etClock, type MarketSession } from '@/lib/marketSession'

const base: MarketSession = {
  state: 'OPEN', date: '2026-09-24',
  nowMinutesEt: 12 * 60, openMinutesEt: 9 * 60 + 30, closeMinutesEt: 16 * 60,
  basis: '2026-09-24 is a regular session, 16:00 ET; inside those hours',
  source: 'NYSE/Cboe published holiday schedules', readAt: '2026-09-23',
  coverage: { from: '2026-01-01', to: '2026-12-31' },
}

describe('the session label', () => {
  test('an open regular session is plainly open, and says so in green', () => {
    // A marker that is always on is a marker nobody reads — the same reason the
    // degraded-source badge had to leave clean sources plainly live.
    const d = describeSession(base)
    expect(d.label).toBe('MARKET OPEN')
    expect(d.tone).toBe('open')
    expect(d.detail).toContain('NYSE/Cboe')
  })

  test('a half-day is named as one rather than reported as an ordinary session', () => {
    const d = describeSession({ ...base, closeMinutesEt: 13 * 60 })
    expect(d.label).toBe('OPEN · HALF DAY')
    expect(d.tone).toBe('open')
  })

  test('a published closure is closed, and names which kind', () => {
    // Two facts, two labels. Telling a reader "CLOSED" on a Saturday and
    // leaving them to check a holiday schedule is the heat map's own finding
    // about answering "no data" to two different problems.
    expect(describeSession({ ...base, state: 'CLOSED_HOLIDAY' }).label)
      .toBe('CLOSED · HOLIDAY')
    expect(describeSession({ ...base, state: 'CLOSED_WEEKEND' }).label)
      .toBe('CLOSED · WEEKEND')
    const outside = describeSession({ ...base, state: 'CLOSED_OUTSIDE_HOURS' })
    expect(outside.label).toBe('CLOSED · 09:30–16:00 ET')
    expect(outside.tone).toBe('closed')
  })

  test('UNKNOWN is never rendered as closed', () => {
    // The load-bearing case. The calendar answers UNKNOWN past its coverage
    // bound, and a reader who reads "closed" out of "cannot say" has been told
    // something nobody established — the rule `coverage.ts` follows by name.
    for (const s of [
      describeSession({ ...base, state: 'UNKNOWN', openMinutesEt: null, closeMinutesEt: null }),
      describeSession(null),   // the backend did not answer
    ]) {
      expect(s.label).toBe('HOURS UNKNOWN')
      expect(s.tone).toBe('unknown')
      expect(s.label).not.toMatch(/CLOSED|OPEN/)
    }
  })

  test('a backend with no `session` field is UNKNOWN, not a crash', () => {
    // The field is new; an older backend answers 200 without it. Same
    // tolerance the settings page has for a payload with no `sourceNotes`.
    expect(describeSession(null).tone).toBe('unknown')
  })

  test('the clock formatter has no fabricated default', () => {
    expect(etClock(9 * 60 + 30)).toBe('09:30')
    expect(etClock(13 * 60)).toBe('13:00')
    expect(etClock(null)).toBe('—')
    expect(etClock(Number.NaN)).toBe('—')
  })
})

describe('the frontend does not re-derive the verdict', () => {
  test('nothing computes a session from a local clock', () => {
    // The whole point of fetching it. A weekday-and-clock check here is how the
    // label went green on Thanksgiving, and a copy of the holiday table is how
    // the ticker tape ended up with a 2024 price map in front of a live feed.
    const ROOT = join(__dirname, '..')
    const out: string[] = []
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        if (n === 'node_modules' || n === '.next' || n === 'test') continue
        const p = join(d, n)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.tsx?$/.test(n)) out.push(p)
      }
    }
    for (const d of readdirSync(ROOT)) {
      if (['node_modules', '.next', 'test', 'public'].includes(d)) continue
      const p = join(ROOT, d)
      if (statSync(p).isDirectory()) walk(p)
    }

    const offenders: string[] = []
    for (const f of out) {
      const rel = f.slice(ROOT.length + 1)
      if (rel === 'lib/marketSession.ts') continue
      // Comments first. The F-16 CSV guard matched its own docstring — the
      // prose explaining why a name is forbidden contains the name — and this
      // one did too, on the Sidebar comment recording what it replaced.
      const src = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\/|\{\/\*[\s\S]*?\*\/\}|\/\/[^\n]*/g, '')
      if (/\bisRegularHours\b|\bisMarketOpen\b/.test(src)) offenders.push(`${rel}: local session check`)
      if (/getDay\(\)/.test(src)) offenders.push(`${rel}: decides a weekday itself`)
    }
    expect(offenders).toEqual([])
  })

  test('the sidebar reads the hook rather than any local helper', () => {
    const src = readFileSync(join(__dirname, '..', 'components', 'layout', 'Sidebar.tsx'), 'utf8')
    expect(src).toMatch(/useMarketSession\(\)/)
    expect(src).toMatch(/describeSession\(/)
    // And it must not paint UNKNOWN with the closed colour — three states, three
    // tones, decided in one place.
    expect(src).toMatch(/TONE\[session\.tone\]/)
  })
})
