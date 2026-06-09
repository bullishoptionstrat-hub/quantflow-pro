import type { BSResult, StrategyLeg } from './types'

// Cumulative normal distribution
function cdf(x: number): number {
  const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911
  const sign = x < 0 ? -1 : 1
  x = Math.abs(x) / Math.sqrt(2)
  const t = 1.0 / (1.0 + p * x)
  const y = 1.0 - (((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x)
  return 0.5 * (1.0 + sign * y)
}

function pdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI)
}

export function blackScholes(
  type: 'C' | 'P',
  params: { S: number; K: number; T: number; r: number; sigma: number }
): BSResult {
  const { S, K, T, r, sigma } = params
  if (T <= 0) {
    const intrinsic = type === 'C' ? Math.max(S - K, 0) : Math.max(K - S, 0)
    return { price: intrinsic, delta: type === 'C' ? (S > K ? 1 : 0) : (S < K ? -1 : 0), gamma: 0, theta: 0, vega: 0, rho: 0 }
  }
  const sqrtT = Math.sqrt(T)
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT)
  const d2 = d1 - sigma * sqrtT
  const nd1 = cdf(type === 'C' ? d1 : -d1)
  const nd2 = cdf(type === 'C' ? d2 : -d2)
  const price = type === 'C'
    ? S * nd1 - K * Math.exp(-r * T) * nd2
    : K * Math.exp(-r * T) * cdf(-d2) - S * cdf(-d1)
  const delta = type === 'C' ? cdf(d1) : cdf(d1) - 1
  const gamma = pdf(d1) / (S * sigma * sqrtT)
  const theta = type === 'C'
    ? (-S * pdf(d1) * sigma / (2 * sqrtT) - r * K * Math.exp(-r * T) * cdf(d2)) / 365
    : (-S * pdf(d1) * sigma / (2 * sqrtT) + r * K * Math.exp(-r * T) * cdf(-d2)) / 365
  const vega = S * pdf(d1) * sqrtT / 100
  const rho = type === 'C'
    ? K * T * Math.exp(-r * T) * cdf(d2) / 100
    : -K * T * Math.exp(-r * T) * cdf(-d2) / 100
  return { price, delta, gamma, theta, vega, rho }
}

export function impliedVolatility(
  type: 'C' | 'P',
  marketPrice: number,
  params: { S: number; K: number; T: number; r: number }
): number {
  let sigma = 0.3
  for (let i = 0; i < 100; i++) {
    const bs = blackScholes(type, { ...params, sigma })
    const diff = bs.price - marketPrice
    if (Math.abs(diff) < 1e-6) return sigma
    const vega = bs.vega * 100
    if (Math.abs(vega) < 1e-10) break
    sigma -= diff / vega
    if (sigma <= 0) sigma = 0.001
    if (sigma > 10) sigma = 10
  }
  return sigma
}

export function computePLCurve(
  legs: StrategyLeg[],
  priceRange: number[],
  daysToExpiry: number,
  r = 0.05
): number[] {
  return priceRange.map(price =>
    legs.reduce((total, leg) => {
      const T = Math.max(daysToExpiry / 365, 0)
      const bs = blackScholes(leg.optionType, { S: price, K: leg.strike, T, r, sigma: leg.iv / 100 })
      const curr = bs.price * 100 * Math.abs(leg.qty)
      const entry = leg.entryPrice * 100 * Math.abs(leg.qty)
      return total + (leg.qty > 0 ? curr - entry : entry - curr)
    }, 0)
  )
}

export function computeGEX(
  contracts: Array<{ strike: number; callOI: number; putOI: number; gamma: number; spotPrice: number }>
): GEXLevel[] {
  return contracts.map(c => {
    const callGEX = c.callOI * c.gamma * c.spotPrice * c.spotPrice * 0.01
    const putGEX = -c.putOI * c.gamma * c.spotPrice * c.spotPrice * 0.01
    const netGEX = callGEX + putGEX
    const levelType: 'SUPPORT' | 'RESISTANCE' | 'FLIP' =
      netGEX > 0 ? 'SUPPORT' : netGEX < 0 ? 'RESISTANCE' : 'FLIP'
    return { strike: c.strike, net_gex: netGEX, call_gex: callGEX, put_gex: putGEX, level_type: levelType }
  }).sort((a, b) => Math.abs(b.net_gex) - Math.abs(a.net_gex))
}

export interface GEXLevel {
  strike: number
  net_gex: number
  call_gex: number
  put_gex: number
  level_type: 'SUPPORT' | 'RESISTANCE' | 'FLIP'
}
