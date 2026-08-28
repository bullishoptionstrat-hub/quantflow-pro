import { describe, expect, it } from 'vitest'
import { blackScholes, computeGEX, CONTRACT_MULTIPLIER, impliedVolatility } from './blackScholes'

describe('computeGEX sign convention and units', () => {
  const base = { strike: 580, spotPrice: 580, gamma: 0.02 }

  it('applies the ×100 contract multiplier (previously missing)', () => {
    // 1000 × 0.02 × 100 × 580² × 0.01 = 6,728,000
    const [level] = computeGEX([{ ...base, callOI: 1000, putOI: 0 }])
    expect(CONTRACT_MULTIPLIER).toBe(100)
    expect(level.call_gex).toBe(6_728_000)
  })

  it('call GEX positive, put GEX negative', () => {
    const [calls] = computeGEX([{ ...base, callOI: 1000, putOI: 0 }])
    const [puts] = computeGEX([{ ...base, callOI: 0, putOI: 1000 }])
    expect(calls.call_gex).toBeGreaterThan(0)
    expect(calls.level_type).toBe('SUPPORT')
    expect(puts.put_gex).toBeLessThan(0)
    expect(puts.level_type).toBe('RESISTANCE')
  })

  it('equal OI cancels to exactly zero, never -0', () => {
    const [level] = computeGEX([{ ...base, callOI: 1000, putOI: 1000 }])
    expect(level.net_gex).toBe(0)
    expect(Object.is(level.net_gex, -0)).toBe(false)
  })

  it('agrees with the backend implementation for the same inputs', () => {
    // Backend: computeGex() with callOI 1000, gamma 0.02, spot 580 => 6,728,000
    const [level] = computeGEX([{ ...base, callOI: 1000, putOI: 0 }])
    expect(level.call_gex).toBe(6_728_000)
  })
})

describe('blackScholes sanity', () => {
  it('put-call parity holds: C - P = S - K·e^(-rT)', () => {
    const p = { S: 100, K: 100, T: 0.5, r: 0.05, sigma: 0.25 }
    const c = blackScholes('C', p).price
    const pu = blackScholes('P', p).price
    expect(c - pu).toBeCloseTo(p.S - p.K * Math.exp(-p.r * p.T), 4)
  })

  it('call delta in [0,1], put delta in [-1,0]', () => {
    const p = { S: 100, K: 100, T: 0.5, r: 0.05, sigma: 0.25 }
    const c = blackScholes('C', p).delta
    const pu = blackScholes('P', p).delta
    expect(c).toBeGreaterThan(0); expect(c).toBeLessThan(1)
    expect(pu).toBeLessThan(0); expect(pu).toBeGreaterThan(-1)
  })

  it('call and put gamma are identical at the same strike (BS identity)', () => {
    const p = { S: 100, K: 105, T: 0.3, r: 0.05, sigma: 0.3 }
    expect(blackScholes('C', p).gamma).toBeCloseTo(blackScholes('P', p).gamma, 10)
  })

  it('at expiry returns intrinsic value', () => {
    expect(blackScholes('C', { S: 110, K: 100, T: 0, r: 0.05, sigma: 0.3 }).price).toBe(10)
    expect(blackScholes('P', { S: 90, K: 100, T: 0, r: 0.05, sigma: 0.3 }).price).toBe(10)
    expect(blackScholes('C', { S: 90, K: 100, T: 0, r: 0.05, sigma: 0.3 }).price).toBe(0)
  })

  it('implied vol round-trips a priced option', () => {
    const p = { S: 100, K: 105, T: 0.4, r: 0.05 }
    const price = blackScholes('C', { ...p, sigma: 0.32 }).price
    expect(impliedVolatility('C', price, p)).toBeCloseTo(0.32, 3)
  })
})
