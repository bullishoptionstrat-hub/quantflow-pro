/**
 * The strategy optimizer, whose ranking was an artifact of a sign error.
 *
 * `prob` fed 40% of the score and was read off `delta`. `blackScholes` returns
 * a negative put delta, so `(1 - bs.delta) * 100` on an ATM put was **142**,
 * and Long Put took the gold `#1` badge with a score of **117** on a scale
 * that reads 0–100. Bear Put Spread was listed with no pricing branch and fell
 * to `else { risk = 100; reward = 200; prob = 50; legs = ['—'] }` — hardcoded
 * numbers rendered in the same markup as computed ones, ranked fourth.
 *
 * A source scan can assert the `else` is gone. Only a render can assert that
 * six rows now carry six computed positions, that no score exceeds its stated
 * ceiling, and that the page has stopped calling itself AI-ranked.
 */
import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import OptimizerPage from '@/app/optimizer/page'
import { blackScholes } from '@/lib/blackScholes'

/** Every strategy row on the page, in ranked order. */
function rows(container: HTMLElement) {
  return Array.from(container.querySelectorAll('.card'))
    .filter(el => /^#\d+$/.test(el.querySelector('span')?.textContent ?? ''))
}

const scoresOf = (container: HTMLElement) =>
  rows(container).map(r => {
    const m = r.textContent?.match(/=\s*(\d+)\/(\d+)/)
    return { total: Number(m?.[1]), ceiling: Number(m?.[2]) }
  })

describe('the fabricated row is gone', () => {
  test('every strategy is priced, none falls through to $100/$200', () => {
    const { container } = render(<OptimizerPage />)
    const all = rows(container)
    expect(all.length).toBe(6)

    // The `else` branch's signature was `legs: ['—']`. Every row now carries
    // real legs, each priced. (An em dash still appears in the P(ITM) column
    // of the straddle, where the quantity genuinely has no value — that is
    // the point of the column, so the check is on the legs.)
    for (const row of all) {
      expect(row.textContent, `${row.textContent?.slice(0, 40)} has no priced legs`)
        .toMatch(/(BUY|SELL) \d+[CP] @ \$[\d.]+/)
    }
    const bearPut = all.find(r => r.textContent?.includes('Bear Put Spread'))!
    expect(bearPut).toBeDefined()
    expect(bearPut.textContent).toMatch(/BUY \d+P @ \$/)
    expect(bearPut.textContent).toMatch(/SELL \d+P @ \$/)
    // $100 risk / $200 reward were the fabricated constants, and 2.00x their ratio.
    expect(bearPut.textContent).not.toMatch(/\$100.*\$200|2\.00x/)
  })

  test('a leg is priced at the strike printed on it', () => {
    // The spreads called `blackScholes` at `atm * 1.05` and displayed
    // `Math.round(atm * 1.05 / 5) * 5`, so the quoted price belonged to a
    // strike the reader never saw.
    const { container } = render(<OptimizerPage />)
    const spread = rows(container).find(r => r.textContent?.includes('Bull Call Spread'))!
    const legs = Array.from((spread.textContent ?? '').matchAll(/(BUY|SELL) (\d+)C @ \$([\d.]+)/g))
    expect(legs.length).toBe(2)

    // Re-price each displayed strike at the page's default inputs and match.
    for (const [, , strike, shown] of legs) {
      const bs = blackScholes('C', {
        S: 500, K: Number(strike), T: 21 / 365, r: 0.05, sigma: 0.15,
      })
      expect(bs.price.toFixed(2)).toBe(shown)
    }
  })
})

describe('the score is bounded and shown in parts', () => {
  test('no total exceeds the ceiling it is printed against', () => {
    // The old score reached 117 on a scale a reader takes for 0–100, because
    // `prob` could be 142.
    const { container } = render(<OptimizerPage />)
    const scores = scoresOf(container)
    expect(scores.length).toBe(6)
    for (const s of scores) {
      expect(s.ceiling).toBe(100)
      expect(s.total).toBeLessThanOrEqual(s.ceiling)
      expect(s.total).toBeGreaterThanOrEqual(0)
    }
  })

  test('each row shows the three terms that produced its total', () => {
    // `ml_score`'s resolution: an opaque number goes, a per-component
    // breakdown stays, because it is a strictly better thing to show.
    const { container } = render(<OptimizerPage />)
    for (const row of rows(container)) {
      expect(row.textContent).toMatch(/P (—|[\d.]+)\/40/)
      expect(row.textContent).toMatch(/R\/R [\d.]+\/40/)
      expect(row.textContent).toMatch(/IV \d+\/20/)
    }
  })

  test('the rows are ordered by the score they display', () => {
    const { container } = render(<OptimizerPage />)
    const totals = scoresOf(container).map(s => s.total)
    expect([...totals].sort((a, b) => b - a)).toEqual(totals)
  })
})

describe('no probability is invented, and none exceeds 100%', () => {
  test('no percentage on any row exceeds 100', () => {
    // 142% was on screen in everything but name: it was not rendered, but it
    // set the ranking. Now that P(ITM) has its own column, the value is
    // visible and must be a probability.
    const { container } = render(<OptimizerPage />)
    let seen = 0
    for (const row of rows(container)) {
      for (const m of Array.from((row.textContent ?? '').matchAll(/(\d+)%/g))) {
        expect(Number(m[1])).toBeLessThanOrEqual(100)
        seen++
      }
    }
    expect(seen).toBeGreaterThan(0)
  })

  test('the straddle reports no directional probability rather than 50', () => {
    // It was a hardcoded 50, and the iron condor a hardcoded 70. One leg of a
    // straddle always finishes ITM, so the column has no answer for it — and
    // the row says its total is therefore not comparable.
    const { container } = render(<OptimizerPage />)
    const straddle = rows(container).find(r => r.textContent?.includes('Long Straddle'))!
    expect(straddle.textContent).toMatch(/P —\/40/)
    expect(straddle.textContent).toMatch(/not comparable/i)
  })

  test('the iron condor names what its probability is of', () => {
    const { container } = render(<OptimizerPage />)
    const condor = rows(container).find(r => r.textContent?.includes('Iron Condor'))!
    expect(condor.textContent).toMatch(/P\(between \d+ and \d+ at expiry\)/)
  })

  test('a long put is not credited with a 142% probability', () => {
    const { container } = render(<OptimizerPage />)
    const put = rows(container).find(r => r.textContent?.includes('Long Put'))!
    expect(put.textContent).toMatch(/P\(below \d+ at expiry\)/)
    // The term is `prob * 0.4`, so 142 produced 56.8 — above the 40 cap.
    const term = Number(put.textContent?.match(/P ([\d.]+)\/40/)?.[1])
    expect(term).toBeLessThanOrEqual(40)
  })

  test("a long put's reward names the assumption behind it", () => {
    // $54,870 at the old defaults: the profit if the underlying goes to zero,
    // printed beside a long call's ∞ with nothing saying so. And the
    // description claimed "Unlimited downside profit", which a put cannot have.
    const { container } = render(<OptimizerPage />)
    const put = rows(container).find(r => r.textContent?.includes('Long Put'))!
    expect(put.textContent).toMatch(/at \$0/)
    expect(container.textContent).not.toMatch(/Unlimited downside/i)
  })
})

describe('the page no longer claims to be AI or to be current', () => {
  test('the subtitle claims neither', () => {
    // There is no model here; `ml-service` was deleted for exactly this. And
    // none of the four inputs comes from a feed — spot defaulted to 557, a
    // 2024 level from the same map the ticker tape was jittering.
    const { container } = render(<OptimizerPage />)
    expect(container.textContent).not.toMatch(/AI-ranked|current conditions/i)
    expect(container.textContent).toMatch(/Not live market data/i)
    expect(container.textContent).not.toMatch(/\b557\b/)
  })

  test('the assumed interest rate is on screen', () => {
    // It was `r: 0.05` inline at four call sites, with nothing saying a rate
    // had been assumed at all.
    render(<OptimizerPage />)
    expect(screen.getByText(/RISK-FREE/i)).toBeDefined()
  })
})
