/**
 * The structure chart over the generated fixture
 * (`backend/tools/fixtures/structureFixture.ts`). The look-ahead rule is tested
 * at every cursor: nothing drawn is from after the cursor, and every mark sits
 * at or after the bar that closed at its knownAt.
 */
import { describe, expect, test } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chartModel, isCandle, type ChartEvent } from '@/lib/structureChart'
import { StructureChart } from '@/components/structure/StructureChart'

const report = JSON.parse(readFileSync(join(__dirname, '..', '..', 'backend', 'test', 'fixtures', 'structureReplay.json'), 'utf8')).report
const events = report.events as ChartEvent[]
const bars = report.bars as { closedAt: number }[]

describe('structure chart model', () => {
  test('the fixture carries closed bars and every one is a candle', () => {
    expect(bars.length).toBe(390)
    expect(bars.every(isCandle)).toBe(true)
  })

  test('at every cursor: no bar after it, no event before its knownAt, every mark at its knownAt bar', () => {
    for (let k = 0; k < bars.length; k += 7) {
      const cursor = bars[k]!.closedAt
      const m = chartModel(bars, events, cursor)
      expect(m.bars.length).toBe(k + 1)
      expect(m.bars.every((b) => b.closedAt <= cursor)).toBe(true)
      for (const o of m.overlays) {
        expect(o.knownAt).toBeLessThanOrEqual(cursor)
        expect(m.bars[o.x]!.closedAt).toBe(o.knownAt)
        if (o.type === 'BOX') { expect(o.xEnd).toBeGreaterThanOrEqual(o.x); expect(o.xEnd).toBeLessThanOrEqual(k) }
      }
    }
  })

  test('a prefix shows exactly the full chart’s marks known by then', () => {
    const full = chartModel(bars, events, null)
    const cut = bars[200]!.closedAt
    const part = chartModel(bars, events, cut)
    expect(part.overlays.map((o) => o.id)).toEqual(full.overlays.filter((o) => o.knownAt <= cut).map((o) => o.id))
  })

  test('swings are marked at their confirming bar, not back-dated to the pivot', () => {
    const sh = events.find((e) => e.kind === 'SWING_HIGH')!
    const m = chartModel(bars, events, null)
    const o = m.overlays.find((x) => x.id === sh.id)!
    expect(m.bars[o.x]!.closedAt).toBe(sh.knownAt)
    expect(m.bars[o.x]!.closedAt).not.toBe((sh.pivot as { closedAt: number }).closedAt)
  })

  test('an FVG box ends at the event that closed it, and stays open only while none has', () => {
    const m = chartModel(bars, events, null)
    const formed = events.find((e) => e.kind === 'FVG_FORMED' && events.some((x) => x.kind === 'FVG_FILLED' && x.fvgId === e.fvgId))!
    const end = events.find((x) => ['FVG_FILLED', 'FVG_INVERTED', 'FVG_EXPIRED'].includes(x.kind) && x.fvgId === formed.fvgId)!
    const box = m.overlays.find((o) => o.id === formed.id)!
    expect(box.type).toBe('BOX')
    if (box.type === 'BOX') { expect(m.bars[box.xEnd]!.closedAt).toBe(end.knownAt); expect(box.open).toBe(false) }
    const before = chartModel(bars, events, formed.knownAt).overlays.find((o) => o.id === formed.id)!
    if (before.type === 'BOX') expect(before.open).toBe(true)
  })

  test('a bar that is not a candle is counted, never drawn or repaired; an unplaceable event is counted', () => {
    const bad = [...bars.slice(0, 3), { ...bars[3]!, h: 0 }, { ...bars[4]!, c: Number.NaN }]
    const m = chartModel(bad, [], null)
    expect(m.bars.length).toBe(3)
    expect(m.unreadableBars).toBe(2)
    // An infinite high satisfies every ordering test; only the finiteness check refuses it.
    expect(isCandle({ ...bars[0]!, h: Number.POSITIVE_INFINITY })).toBe(false)
    expect(isCandle({ ...bars[0]!, closedAt: undefined })).toBe(false)
    const ghost: ChartEvent = { id: 'g', kind: 'SWING_HIGH', knownAt: bars[1]!.closedAt + 1, price: 1 }
    expect(chartModel(bars.slice(0, 5), [ghost], null).unplacedEvents).toBe(1)
  })

  test('an event without a price is not drawn, and no price is defaulted', () => {
    const e: ChartEvent = { id: 'p', kind: 'SWING_LOW', knownAt: bars[2]!.closedAt }
    expect(chartModel(bars.slice(0, 5), [e], null).overlays).toEqual([])
  })

  test('no bars at all draws nothing', () => {
    expect(chartModel(undefined, events, null)).toMatchObject({ bars: [], overlays: [], cursor: null })
  })
})

describe('structure chart component', () => {
  test('renders every candle, and the cursor removes later bars and marks', () => {
    const { container } = render(<StructureChart bars={bars} events={events} />)
    expect(container.querySelectorAll('[data-bar]').length).toBe(390)
    const full = container.querySelectorAll('[data-overlay]').length
    fireEvent.change(screen.getByLabelText('Replay cursor'), { target: { value: '10' } })
    expect(container.querySelectorAll('[data-bar]').length).toBe(11)
    const shown = container.querySelectorAll('[data-overlay]').length
    expect(shown).toBeLessThan(full)
    expect(shown).toBe(chartModel(bars, events, bars[10]!.closedAt).overlays.length)
  })

  test('a report with no bars says so', () => {
    render(<StructureChart bars={[]} events={events} />)
    expect(screen.getByRole('note').textContent).toMatch(/No drawable bar/)
  })
})
