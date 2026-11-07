/**
 * The risk & position-size calculator.
 *
 * Each block holds one rule the module exists for, with numbers worked by hand
 * in the comment beside them, so a failure says which rule broke rather than
 * which number moved.
 */
import { describe, expect, test } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { render, screen, fireEvent } from '@testing-library/react'
import { sizePosition, splitUnits, type SizingInput } from '@/lib/riskSize'
import { CONTRACT_SPECS, SPEC_SOURCE, specFor } from '@/lib/contractSpecs'

const spec = (symbol: string) => {
  const s = specFor(symbol)
  if (!s) throw new Error(`no spec ${symbol}`)
  return { tickSize: s.tickSize, tickValue: s.tickValue, unit: s.unit, micro: s.micro }
}

const base = (o: Partial<SizingInput> = {}): SizingInput => ({
  spec: spec('ES'), side: 'LONG', entry: 5000, stop: 4990, targets: [],
  riskBudget: 1100, costPerUnit: 5, slippageTicks: 1, minR: 2, ...o,
})

describe('ticks times tick value', () => {
  test('ES: 10 points is 40 ticks, plus a tick of slippage and the cost', () => {
    // (40 + 1) × 12.50 + 5 = 517.50 per contract; 1100 / 517.50 = 2.13 → 2.
    const r = sizePosition(base())
    expect(r.stopTicks).toBe(40)
    expect(r.stopPoints).toBe(10)
    expect(r.lossPerUnit).toBeCloseTo(517.5, 9)
    expect(r.units).toBe(2)
    expect(r.plannedRisk).toBeCloseTo(1035, 9)
    expect(r.budgetUnused).toBeCloseTo(65, 9)
  })

  test('NQ: a 10-point stop is $200 a contract, not 10 × $5', () => {
    // The error the trade-ticket rules name: points × dollars-per-tick reads $50.
    const r = sizePosition(base({ spec: spec('NQ'), entry: 20000, stop: 19990, riskBudget: 1000, costPerUnit: 0, slippageTicks: 0 }))
    expect(r.lossPerUnit).toBe(200)
    expect(r.units).toBe(5)
  })
})

describe('never rounded up', () => {
  test('one contract over budget is zero contracts, with the micro named', () => {
    const r = sizePosition(base({ riskBudget: 500 }))
    expect(r.verdict).toBe('NO_SIZE')
    expect(r.units).toBe(0)
    expect(r.plannedRisk).toBe(0)
    expect(r.errors.join(' ')).toMatch(/MES/)
    expect(r.errors.join(' ')).toMatch(/not rounded up/)
  })

  test('without a micro listed, the answer is still pass', () => {
    const r = sizePosition(base({ spec: spec('MES'), riskBudget: 10 }))
    expect(r.verdict).toBe('NO_SIZE')
    expect(r.errors.join(' ')).toMatch(/Pass/)
  })

  test('an exact budget survives float division: 0.3 / 0.1 is three units, not two', () => {
    // SPY, 10 cents of stop, no costs: 0.10 a share; 0.30 buys exactly three.
    const r = sizePosition(base({ spec: spec('SPY'), entry: 100, stop: 99.9, riskBudget: 0.3, costPerUnit: 0, slippageTicks: 0 }))
    expect(r.units).toBe(3)
  })

  test('across a sweep, the size is the largest that fits and never more', () => {
    for (const budget of [100, 517.49, 517.5, 999.99, 1035, 2500, 12345.67]) {
      for (const stop of [4999.75, 4995, 4990, 4980.25, 4950]) {
        const r = sizePosition(base({ riskBudget: budget, stop }))
        expect(r.plannedRisk).toBeLessThanOrEqual(budget * (1 + 1e-9))
        expect((r.units + 1) * r.lossPerUnit).toBeGreaterThan(budget)
      }
    }
  })
})

describe('off-grid prices round the conservative way, and say so', () => {
  test('a stop off the grid is more ticks; a target off the grid is fewer', () => {
    // 10.1 points = 40.4 ticks → 41 at the stop, 40 at the target.
    const r = sizePosition(base({ stop: 4989.9, targets: [{ price: 5010.1 }] }))
    expect(r.stopTicks).toBe(41)
    expect(r.stopOffGrid).toBe(true)
    expect(r.targets[0]!.ticks).toBe(40)
    expect(r.targets[0]!.offGrid).toBe(true)
    expect(r.warnings.join(' ')).toMatch(/rounded up/)
    expect(r.warnings.join(' ')).toMatch(/rounded down/)
  })

  // The two directions are tested apart as well, so deleting or editing the
  // combined case above leaves neither one unguarded.
  test('an off-grid stop alone is rounded up, and the size follows it', () => {
    // 10.1 points = 40.4 ticks → 41; (41 + 1) × 12.50 + 5 = 530 a contract.
    // Rounded down to 40 it would read 517.50, and 1,059.99 would buy 2 instead of 1.
    const r = sizePosition(base({ stop: 4989.9, riskBudget: 1060 }))
    expect(r.stopTicks).toBe(41)
    expect(r.lossPerUnit).toBeCloseTo(530, 9)
    expect(r.units).toBe(2)
    const tight = sizePosition(base({ stop: 4989.9, riskBudget: 1059.99 }))
    expect(tight.units).toBe(1)
  })

  test('an off-grid target alone is rounded down, and the R follows it', () => {
    // MNQ, 20-tick stop at 0.50 = 10, no costs. Target 20010.1 = 40.4 ticks → 40:
    // exactly 2R. Rounded up to 41 it would read 2.05R.
    const r = sizePosition(base({
      spec: spec('MNQ'), entry: 20000, stop: 19995, targets: [{ price: 20010.1 }],
      riskBudget: 100, costPerUnit: 0, slippageTicks: 0,
    }))
    expect(r.stopOffGrid).toBe(false)
    expect(r.targets[0]!.ticks).toBe(40)
    expect(r.blendedNetR).toBeCloseTo(2, 12)
  })

  test('float noise on an on-grid price is not called off-grid', () => {
    // 100 − 99.9 is 0.09999999999999432; still exactly 10 cents.
    const r = sizePosition(base({ spec: spec('SPY'), entry: 100, stop: 99.9, riskBudget: 50, costPerUnit: 0, slippageTicks: 0 }))
    expect(r.stopTicks).toBe(10)
    expect(r.stopOffGrid).toBe(false)
    expect(r.warnings).toEqual([])
  })
})

describe('R is net of costs', () => {
  const mnq = (cost: number) => sizePosition(base({
    spec: spec('MNQ'), entry: 20000, stop: 19995, targets: [{ price: 20010 }],
    riskBudget: 100, costPerUnit: cost, slippageTicks: 0,
  }))

  test('a gross 2R trade with costs is below 2R, and the gate sees it', () => {
    // Stop 20 ticks × 0.50 = 10, target 40 ticks × 0.50 = 20: 2.0R gross.
    // With 1.50 round trip: (20 − 1.5) / (10 + 1.5) = 1.61R.
    const r = mnq(1.5)
    expect(r.targets[0]!.grossR).toBe(2)
    expect(r.targets[0]!.netR).toBeCloseTo(18.5 / 11.5, 9)
    expect(r.verdict).toBe('BELOW_MIN_R')
  })

  test('the same trade with no costs is exactly 2R, which meets a 2R minimum', () => {
    const r = mnq(0)
    expect(r.blendedNetR).toBeCloseTo(2, 12)
    expect(r.verdict).toBe('MEETS_MIN_R')
  })

  test('a target that does not cover its cost is flagged', () => {
    const r = sizePosition(base({ spec: spec('MNQ'), entry: 20000, stop: 19995, targets: [{ price: 20000.25 }], riskBudget: 100, costPerUnit: 1, slippageTicks: 0 }))
    expect(r.warnings.join(' ')).toMatch(/does not cover the round-trip cost/)
  })
})

describe('partial exits are blended from the split that can be filled', () => {
  // ES, 40-tick stop, no costs: $500 a contract; $2,000 buys 4.
  const blended = (s1: number, s2: number) => sizePosition(base({
    riskBudget: 2000, costPerUnit: 0, slippageTicks: 0,
    targets: [{ price: 5010, share: s1 }, { price: 5030, share: s2 }],
  }))

  test('half at 1R and half at 3R is 2R', () => {
    const r = blended(0.5, 0.5)
    expect(r.targets.map((t) => t.units)).toEqual([2, 2])
    expect(r.blendedNetR).toBeCloseTo(2, 12)
    expect(r.verdict).toBe('MEETS_MIN_R')
  })

  test('a 3R runner does not make a trade that takes most of its size off at 1R a 3R trade', () => {
    // 3 × $500 + 1 × $1,500 = $3,000 on $2,000 of risk: 1.5R.
    const r = blended(0.75, 0.25)
    expect(r.targets[1]!.grossR).toBe(3)
    expect(r.blendedNetR).toBeCloseTo(1.5, 12)
    expect(r.verdict).toBe('BELOW_MIN_R')
  })

  test('an odd size splits in whole units, and the blend reads that split', () => {
    // $1,500 buys 3. Half and half of 3 is 2 at TP1 and 1 at TP2, not 1.5 each:
    // 2 × $500 + 1 × $1,500 = $2,500 on $1,500 of risk is 1.67R, below 2R.
    // Blending by share would read 1.5 × $500 + 1.5 × $1,500 = $3,000, a 2R pass.
    const r = sizePosition(base({
      riskBudget: 1500, costPerUnit: 0, slippageTicks: 0,
      targets: [{ price: 5010, share: 0.5 }, { price: 5030, share: 0.5 }],
    }))
    expect(r.units).toBe(3)
    expect(r.targets.map((t) => t.units)).toEqual([2, 1])
    expect(r.blendedNetR).toBeCloseTo(2500 / 1500, 12)
    expect(r.verdict).toBe('BELOW_MIN_R')
  })

  test('a share that rounds to no units is said, and the blend uses what can be filled', () => {
    // $500 budget: one contract, all of it to TP1.
    const r = sizePosition(base({
      riskBudget: 500, costPerUnit: 0, slippageTicks: 0,
      targets: [{ price: 5010, share: 0.5 }, { price: 5030, share: 0.5 }],
    }))
    expect(r.targets.map((t) => t.units)).toEqual([1, 0])
    expect(r.blendedNetR).toBeCloseTo(1, 12)
    expect(r.warnings.join(' ')).toMatch(/TP2's 50% rounds to none/)
  })

  test('splitUnits always sums to the size and breaks ties toward the earlier target', () => {
    expect(splitUnits(3, [0.5, 0.5])).toEqual([2, 1])
    expect(splitUnits(7, [0.2, 0.3, 0.5])).toEqual([1, 2, 4])
    for (let u = 0; u <= 25; u++) {
      for (const shares of [[1], [0.5, 0.5], [0.34, 0.33, 0.33], [0.1, 0.9]]) {
        expect(splitUnits(u, shares).reduce((a, b) => a + b, 0)).toBe(u)
      }
    }
  })
})

describe('what cannot be sized is refused, not guessed', () => {
  const errs = (o: Partial<SizingInput>) => {
    const r = sizePosition(base(o))
    expect(r.verdict).toBe('INVALID')
    expect(r.units).toBe(0)
    return r.errors.join(' ')
  }

  test('no risk budget is an error, never a default', () => {
    expect(errs({ riskBudget: null })).toMatch(/never assumed/)
    expect(errs({ riskBudget: 0 })).toMatch(/never assumed/)
  })

  test('a missing cost or slippage is not zero', () => {
    expect(errs({ costPerUnit: null })).toMatch(/not a zero cost/)
    expect(errs({ slippageTicks: null })).toMatch(/slippage/)
  })

  test('a stop on the wrong side of the entry', () => {
    expect(errs({ stop: 5010 })).toMatch(/long stop must be below/)
    expect(errs({ side: 'SHORT', stop: 4990 })).toMatch(/short stop must be above/)
    expect(errs({ stop: 5000 })).toMatch(/equals the entry/)
  })

  test('a target on the wrong side of the entry', () => {
    expect(errs({ targets: [{ price: 4995 }] })).toMatch(/TP1 must be above/)
    expect(errs({ side: 'SHORT', stop: 5010, targets: [{ price: 5005 }] })).toMatch(/TP1 must be below/)
  })

  test('shares that do not add up to the whole position', () => {
    expect(errs({ targets: [{ price: 5010, share: 0.5 }, { price: 5020, share: 0.3 }] })).toMatch(/add up to 100%/)
    expect(errs({ targets: [{ price: 5010, share: 0.5 }, { price: 5020 }] })).toMatch(/give every target a share/)
    expect(errs({ targets: [{ price: 5010, share: 0.5 }] })).toMatch(/single target exits the whole position/)
  })

  test('numbers that are not numbers', () => {
    expect(errs({ entry: NaN })).toMatch(/Entry/)
    expect(errs({ stop: Infinity })).toMatch(/Stop/)
    expect(errs({ spec: { tickSize: 0, tickValue: 12.5, unit: 'contract' } })).toMatch(/Tick size/)
  })

  test('a short is sized like a long, mirrored', () => {
    const r = sizePosition(base({ side: 'SHORT', stop: 5010, targets: [{ price: 4970 }] }))
    expect(r.units).toBe(2)
    expect(r.targets[0]!.grossR).toBe(3)
    expect(r.verdict).toBe('MEETS_MIN_R')
  })

  test('no target sizes the idea but does not judge its R', () => {
    const r = sizePosition(base())
    expect(r.verdict).toBe('NO_TARGET')
    expect(r.blendedNetR).toBeNull()
  })
})

describe('the contract table', () => {
  test('tick value equals tick size × point value in every row, so one typo cannot hide', () => {
    for (const s of CONTRACT_SPECS) {
      expect(Math.abs(s.tickValue - s.tickSize * s.pointValue), s.symbol).toBeLessThan(1e-9)
      expect(s.tickSize, s.symbol).toBeGreaterThan(0)
    }
  })

  test('symbols are unique, and every micro named is a smaller row in the table', () => {
    const symbols = CONTRACT_SPECS.map((s) => s.symbol)
    expect(new Set(symbols).size).toBe(symbols.length)
    for (const s of CONTRACT_SPECS.filter((x) => x.micro)) {
      const m = specFor(s.micro!)
      expect(m, `${s.symbol} → ${s.micro}`).toBeDefined()
      expect(m!.pointValue).toBeLessThan(s.pointValue)
      expect(m!.tickSize).toBe(s.tickSize)
    }
  })

  test('the table does not claim to have been checked against the exchange', () => {
    // A tick value read from memory and shown as verified would mis-size a live
    // order by the same factor. The status changes only with a dated reading.
    expect(SPEC_SOURCE.status).toBe('UNVERIFIED')
    expect(SPEC_SOURCE.instruction).toMatch(/broker/)
  })
})

describe('every page is behind the middleware', () => {
  test('the matcher lists every route directory under app/', () => {
    // The matcher is a hand-written list, so a new page is ungated until someone
    // remembers to add it. This reads the pages that exist instead.
    const appDir = join(__dirname, '..', 'app')
    const pages: string[] = []
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f)
        if (statSync(p).isDirectory()) walk(p)
        else if (f === 'page.tsx') pages.push(p)
      }
    }
    walk(appDir)
    const routes = pages
      .map((p) => '/' + relative(appDir, p).split(sep).slice(0, -1).filter((s) => !/^\(.*\)$/.test(s)).join('/'))
      .filter((r) => r !== '/') // the landing page is public by design
    const mw = readFileSync(join(__dirname, '..', 'middleware.ts'), 'utf8')
    for (const r of routes) {
      expect(mw, `${r} is not in the middleware matcher`).toContain(`'${r}/:path*'`)
    }
    expect(routes).toContain('/risk')
  })
})

describe('the page', () => {
  test('sizes an ES idea from what is typed, and asks for nothing it can assume', async () => {
    const { default: RiskPage } = await import('@/app/risk/page')
    render(<RiskPage />)

    expect(screen.queryByTestId('verdict')).toBeNull()
    expect(screen.getByText(/Enter an entry and a stop/)).toBeTruthy()

    const set = (label: RegExp, v: string) => fireEvent.change(screen.getByLabelText(label), { target: { value: v } })
    set(/^ENTRY$/, '5000')
    set(/^STOP \//, '4990')
    // Entry and stop alone: sized nothing, and says which answers are missing.
    expect(screen.getByTestId('verdict').textContent).toBe('CANNOT SIZE')
    expect(screen.getByText(/never assumed/)).toBeTruthy()

    set(/^RISK BUDGET/, '1100')
    set(/^ROUND-TRIP COST/, '5')
    set(/^STOP SLIPPAGE/, '1')
    set(/^TP1 PRICE$/, '5030')

    expect(screen.getByTestId('verdict').textContent).toBe('MEETS MIN R')
    expect(screen.getByText('2 contracts')).toBeTruthy()
    expect(screen.getByText('$517.50')).toBeTruthy()
    expect(screen.getByText('$1,035.00')).toBeTruthy()
    expect(screen.getByText(/SPEC UNVERIFIED/)).toBeTruthy()
  })

  test('the page source carries no default budget, cost or slippage', () => {
    const src = readFileSync(join(__dirname, '..', 'app', 'risk', 'page.tsx'), 'utf8')
    for (const name of ['budget', 'cost', 'slippage', 'entry', 'stop']) {
      expect(src, name).toMatch(new RegExp(`\\[${name}, set\\w+\\] = useState\\(''\\)`))
    }
  })
})
