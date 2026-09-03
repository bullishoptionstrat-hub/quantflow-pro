'use client'
import { useState, useMemo } from 'react'
import { blackScholes } from '@/lib/blackScholes'

/**
 * The strategy ranking was driven by an arithmetic error, and one of the six
 * rows was made up outright.
 *
 * `prob` fed 40% of the score and was read off `delta`. For a call that is a
 * rough stand-in for the probability of finishing in the money; for a put it is
 * simply wrong, because `blackScholes` returns a **negative** put delta, so
 * `(1 - bs.delta) * 100` on an ATM put returned **142**. Long Put therefore
 * took the gold `#1` badge at the page's default inputs with a score of 117 —
 * on a scale that reads as 0–100 — and its REWARD column read **$54,870**,
 * which is the profit if the underlying goes to zero, printed beside a long
 * call's `∞` with nothing saying so.
 *
 * Bear Put Spread was listed in `STRATEGIES` and had no branch in the pricing,
 * so it fell to `else { risk = 100; reward = 200; prob = 50; legs = ['—'] }`
 * and rendered `RISK $100 · REWARD $200 · R/R 2.00x`, ranked fourth, in the
 * same markup as the computed rows. Hardcoded numbers in live styling: the
 * same family as the ticker tape's price map and the news page's headlines,
 * reached here by a strategy list and a pricing function drifting apart.
 *
 * The spread legs were also priced at one strike and displayed at another —
 * `blackScholes` was called at `atm * 1.05` while the leg chip read
 * `Math.round(atm * 1.05 / 5) * 5`, so the quoted price did not belong to the
 * strike shown.
 *
 * And the page called itself "AI-ranked ... based on current conditions". There
 * is no model here — `ml-service` was deleted for putting a number with no
 * provenance beside a real signal — and nothing on this page is current: spot
 * defaulted to a hardcoded 557, one of the 2024 levels the ticker tape was
 * carrying. Both claims are gone. Seeding spot from the live quote feed is a
 * separate change, along with the same 2024 map still sitting in the watchlist
 * and the calculator.
 */

type StrategyId =
  | 'long_call' | 'long_put'
  | 'bull_call_spread' | 'bear_put_spread'
  | 'straddle' | 'iron_condor'

interface Strategy {
  id: StrategyId
  name: string
  desc: string
}

const STRATEGIES: Strategy[] = [
  { id: 'long_call', name: 'Long Call', desc: 'Bullish · Unlimited upside' },
  // "Unlimited downside profit" was false: a put's profit stops at the strike,
  // because the underlying stops at zero. That bound is what `reward` computes.
  { id: 'long_put', name: 'Long Put', desc: 'Bearish · Profit capped at the strike' },
  { id: 'bull_call_spread', name: 'Bull Call Spread', desc: 'Bullish · Defined risk/reward' },
  { id: 'bear_put_spread', name: 'Bear Put Spread', desc: 'Bearish · Defined risk/reward' },
  { id: 'straddle', name: 'Long Straddle', desc: 'Volatility play · Any direction' },
  { id: 'iron_condor', name: 'Iron Condor', desc: 'Neutral · Premium collection' },
]

interface Inputs {
  spot: number
  /** Implied volatility, in percent. */
  iv: number
  dte: number
  /** Risk-free rate, in percent. Was hardcoded at 5% in four call sites. */
  rate: number
}

interface Plan {
  legs: string[]
  /** Maximum loss on the position, in dollars, one contract per leg. */
  risk: number
  /** Maximum gain, or `Infinity` where the payoff is unbounded. */
  reward: number
  /** The assumption behind `reward`, where it rests on one. */
  rewardNote?: string
  /**
   * Model probability the position finishes in the money at expiry, as a
   * percentage — or `null` where no such single number exists. Never a
   * probability of *profit*: it does not net off the premium.
   */
  prob: number | null
  /** What `prob` is the probability *of*, for this position. */
  probNote: string
}

/**
 * The strike grid.
 *
 * Wings are laid out on it *before* they are priced, so the price quoted on a
 * leg chip belongs to the strike printed on it. Adaptive because the spot
 * slider goes down to 10, where a $5 grid collapses the condor's four strikes
 * onto two and prices a spread of zero width.
 */
function stepFor(spot: number): number {
  return spot < 50 ? 1 : 5
}

const round = (k: number, step: number) => Math.max(step, Math.round(k / step) * step)
/** A strike at least one step above `k`. */
const up = (k: number, pct: number, step: number) => Math.max(round(k * (1 + pct), step), k + step)
/** A strike at least one step below `k`, and never at or below zero. */
const dn = (k: number, pct: number, step: number) => Math.max(step, Math.min(round(k * (1 - pct), step), k - step))

/**
 * One entry per `StrategyId`, checked by the compiler.
 *
 * The `else` branch this replaces is why Bear Put Spread rendered $100/$200:
 * a strategy could be listed and never priced, and the fallback looked exactly
 * like a computed row. A `Record<StrategyId, …>` makes that a type error.
 */
const PRICERS: Record<StrategyId, (i: Inputs) => Plan> = {
  long_call: ({ spot, iv, dte, rate }) => {
    const p = params(spot, iv, dte, rate)
    const step = stepFor(spot)
    const K = round(spot, step)
    const c = blackScholes('C', { ...p, K })
    return {
      legs: [`BUY ${K}C @ $${c.price.toFixed(2)}`],
      risk: c.price * 100,
      reward: Infinity,
      prob: c.probItm * 100,
      probNote: `P(above ${K} at expiry)`,
    }
  },

  long_put: ({ spot, iv, dte, rate }) => {
    const p = params(spot, iv, dte, rate)
    const step = stepFor(spot)
    const K = round(spot, step)
    const put = blackScholes('P', { ...p, K })
    return {
      legs: [`BUY ${K}P @ $${put.price.toFixed(2)}`],
      risk: put.price * 100,
      // Bounded, not unlimited: the underlying cannot go below zero.
      reward: (K - put.price) * 100,
      rewardNote: 'at $0',
      prob: put.probItm * 100,
      probNote: `P(below ${K} at expiry)`,
    }
  },

  bull_call_spread: ({ spot, iv, dte, rate }) => {
    const p = params(spot, iv, dte, rate)
    const step = stepFor(spot)
    const K1 = round(spot, step)
    const K2 = up(K1, 0.05, step)
    const long = blackScholes('C', { ...p, K: K1 })
    const short = blackScholes('C', { ...p, K: K2 })
    const debit = long.price - short.price
    return {
      legs: [`BUY ${K1}C @ $${long.price.toFixed(2)}`, `SELL ${K2}C @ $${short.price.toFixed(2)}`],
      risk: debit * 100,
      reward: (K2 - K1 - debit) * 100,
      prob: long.probItm * 100,
      probNote: `P(above ${K1} at expiry)`,
    }
  },

  bear_put_spread: ({ spot, iv, dte, rate }) => {
    const p = params(spot, iv, dte, rate)
    const step = stepFor(spot)
    const K1 = round(spot, step)
    const K2 = dn(K1, 0.05, step)
    const long = blackScholes('P', { ...p, K: K1 })
    const short = blackScholes('P', { ...p, K: K2 })
    const debit = long.price - short.price
    return {
      legs: [`BUY ${K1}P @ $${long.price.toFixed(2)}`, `SELL ${K2}P @ $${short.price.toFixed(2)}`],
      risk: debit * 100,
      reward: (K1 - K2 - debit) * 100,
      prob: long.probItm * 100,
      probNote: `P(below ${K1} at expiry)`,
    }
  },

  straddle: ({ spot, iv, dte, rate }) => {
    const p = params(spot, iv, dte, rate)
    const step = stepFor(spot)
    const K = round(spot, step)
    const c = blackScholes('C', { ...p, K })
    const put = blackScholes('P', { ...p, K })
    return {
      legs: [`BUY ${K}C @ $${c.price.toFixed(2)}`, `BUY ${K}P @ $${put.price.toFixed(2)}`],
      risk: (c.price + put.price) * 100,
      reward: Infinity,
      // Was a hardcoded 50. One leg of a straddle always finishes in the
      // money, so P(ITM) is ~1 and says nothing about this position; what
      // would say something is a probability of profit, which needs the
      // breakevens and is not what this column reports.
      prob: null,
      probNote: 'one leg is always ITM — no directional probability applies',
    }
  },

  iron_condor: ({ spot, iv, dte, rate }) => {
    const p = params(spot, iv, dte, rate)
    const step = stepFor(spot)
    const mid = round(spot, step)
    const shortPut = dn(mid, 0.03, step)
    const longPut = Math.max(step, Math.min(dn(mid, 0.05, step), shortPut - step))
    const shortCall = up(mid, 0.03, step)
    const longCall = Math.max(up(mid, 0.05, step), shortCall + step)

    const sp = blackScholes('P', { ...p, K: shortPut })
    const lp = blackScholes('P', { ...p, K: longPut })
    const sc = blackScholes('C', { ...p, K: shortCall })
    const lc = blackScholes('C', { ...p, K: longCall })

    const credit = (sp.price - lp.price + sc.price - lc.price) * 100
    const width = Math.max(shortPut - longPut, longCall - shortCall)
    return {
      legs: [
        `SELL ${shortPut}P @ $${sp.price.toFixed(2)}`, `BUY ${longPut}P @ $${lp.price.toFixed(2)}`,
        `SELL ${shortCall}C @ $${sc.price.toFixed(2)}`, `BUY ${longCall}C @ $${lc.price.toFixed(2)}`,
      ],
      risk: width * 100 - credit,
      reward: credit,
      // Was a hardcoded 70. The position wins at expiry when neither short
      // strike is breached, and that is one subtraction on the same quantity:
      // `sp.probItm` is P(below the short put), `sc.probItm` is P(above the
      // short call).
      prob: (1 - sp.probItm - sc.probItm) * 100,
      probNote: `P(between ${shortPut} and ${shortCall} at expiry)`,
    }
  },
}

function params(spot: number, iv: number, dte: number, rate: number) {
  return { S: spot, T: Math.max(dte / 365, 0.01), r: rate / 100, sigma: iv / 100 }
}

/**
 * The three terms behind the score, shown rather than summed away.
 *
 * The number itself is unchanged — re-weighting it would be taste, and the
 * defect was never the weights. What was wrong is that it was an opaque total
 * in 18px gold beside a `#1` badge, fed by a probability of 142. This is the
 * same resolution `ml_score` got: the opaque figure went, and `score.ts` stayed
 * because it publishes a per-component breakdown, which is a strictly better
 * thing to show than one number.
 *
 * Each term is capped, so the total cannot exceed 100 — which the old one did.
 */
interface Score {
  /** `prob × 0.4`, so at most 40. `null` where the strategy has no `prob`. */
  probTerm: number | null
  /** Reward-to-risk, at most 40. */
  rrTerm: number
  /** A flat band on IV, at most 20. */
  ivTerm: number
  total: number
  /** True when a term is missing, so this total is not comparable with a full one. */
  partial: boolean
}

const SCORE_CEILING = 100

function scoreOf(plan: Plan, iv: number): Score {
  const probTerm = plan.prob === null ? null : Math.min(Math.max(plan.prob, 0), 100) * 0.4
  const rrTerm = plan.reward === Infinity ? 40 : Math.min((plan.reward / Math.max(plan.risk, 1)) * 20, 40)
  const ivTerm = iv < 20 ? 20 : iv < 30 ? 15 : 5
  return {
    probTerm, rrTerm, ivTerm,
    total: Math.round((probTerm ?? 0) + rrTerm + ivTerm),
    partial: probTerm === null,
  }
}

export default function OptimizerPage() {
  // 557 was SPY's level in 2024 — the same map the ticker tape was jittering.
  // A slider needs a starting value; what it must not do is present one as a
  // market price, which is why the subtitle no longer claims to be current.
  const [spot, setSpot] = useState(500)
  const [iv, setIv] = useState(15)
  const [dte, setDte] = useState(21)
  // Was `r: 0.05` inline at four call sites, with nothing on screen saying an
  // interest rate had been assumed at all.
  const [rate, setRate] = useState(5)
  const [selected, setSelected] = useState<StrategyId>('bull_call_spread')

  const rows = useMemo(() => {
    const inputs: Inputs = { spot, iv, dte, rate }
    return STRATEGIES
      .map(s => {
        const plan = PRICERS[s.id](inputs)
        return { ...s, plan, score: scoreOf(plan, iv) }
      })
      .sort((a, b) => b.score.total - a.score.total)
  }, [spot, iv, dte, rate])

  const sliders = [
    { label: 'SPOT', value: spot, setter: setSpot, min: 10, max: 6000, step: 1, suffix: '' },
    { label: 'IV', value: iv, setter: setIv, min: 5, max: 150, step: 1, suffix: '%' },
    { label: 'DTE', value: dte, setter: setDte, min: 1, max: 180, step: 1, suffix: 'd' },
    { label: 'RISK-FREE', value: rate, setter: setRate, min: 0, max: 12, step: 1, suffix: '%' },
  ]

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: '#fafafa', marginBottom: 4 }}>⚙ Strategy Optimizer</h1>
        {/* Was "AI-ranked strategy recommendations based on current conditions".
            No model ranks these, and none of the four inputs comes from a
            market feed — they are the sliders below. */}
        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Black-Scholes payoffs for the four assumptions you set below. Not live market data, and not a recommendation.
        </p>
      </div>

      <div className="card" style={{ padding: 16, marginBottom: 20, display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap' }}>
        {sliders.map(p => (
          <div key={p.label} style={{ flex: 1, minWidth: 180 }}>
            <label style={{ fontSize: 10, color: 'var(--text-muted)', display: 'block', marginBottom: 6, fontWeight: 600, letterSpacing: '0.08em' }}>
              {p.label}: <span style={{ color: 'var(--text-secondary)', fontFamily: "'JetBrains Mono', monospace" }}>{p.value}{p.suffix}</span>
            </label>
            <input type="range" min={p.min} max={p.max} value={p.value} step={p.step}
              onChange={e => p.setter(Number(e.target.value))} style={{ width: '100%', accentColor: '#8b5cf6' }} />
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.map((s, rank) => {
          const { plan, score } = s
          const rr = plan.reward === Infinity ? '∞' : (plan.reward / Math.max(plan.risk, 1)).toFixed(2)
          return (
            <div
              key={s.id}
              className="card"
              onClick={() => setSelected(s.id)}
              style={{ padding: 16, cursor: 'pointer', borderColor: selected === s.id ? 'rgba(139,92,246,0.5)' : undefined, background: selected === s.id ? 'rgba(139,92,246,0.06)' : undefined }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 260 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12, fontWeight: 800, color: rank === 0 ? '#fbbf24' : 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>#{rank + 1}</span>
                    <span style={{ fontWeight: 700, fontSize: 14, color: '#fafafa' }}>{s.name}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{s.desc}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 8, fontSize: 11, fontFamily: "'JetBrains Mono', monospace", flexWrap: 'wrap' }}>
                    {plan.legs.map((l, i) => (
                      <span key={i} style={{ background: 'var(--bg-secondary)', padding: '2px 8px', borderRadius: 4, color: 'var(--text-secondary)' }}>{l}</span>
                    ))}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 16, flexShrink: 0, textAlign: 'center' }}>
                  <Stat label="RISK" value={`$${Math.round(plan.risk)}`} color="#ef4444" />
                  <Stat
                    label="REWARD"
                    value={plan.reward === Infinity ? '∞' : `$${Math.round(plan.reward)}`}
                    sub={plan.rewardNote}
                    color="#22c55e"
                  />
                  <Stat label="R/R" value={`${rr}x`} color="#60a5fa" />
                  <Stat
                    label="P(ITM)"
                    value={plan.prob === null ? '—' : `${Math.round(plan.prob)}%`}
                    color="#c4b5fd"
                  />
                  <div>
                    <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: '0.08em', fontWeight: 600, marginBottom: 3 }}>
                      SCORE{score.partial ? '*' : ''}
                    </div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: rank === 0 ? '#fbbf24' : '#a78bfa', fontFamily: "'JetBrains Mono', monospace" }}>
                      {score.total}
                    </div>
                  </div>
                </div>
              </div>

              {/* What produced the score, and what the probability is of. An
                  opaque total beside a gold #1 is what `ml_score` was. */}
              <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.05)', display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 10, color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>
                <span>P {score.probTerm === null ? '—' : score.probTerm.toFixed(1)}/40</span>
                <span>R/R {score.rrTerm.toFixed(1)}/40</span>
                <span>IV {score.ivTerm}/20</span>
                <span style={{ color: 'var(--text-secondary)' }}>= {score.total}/{SCORE_CEILING}</span>
                <span style={{ marginLeft: 'auto', fontFamily: 'inherit' }}>{plan.probNote}</span>
              </div>
              {score.partial && (
                <div style={{ marginTop: 6, fontSize: 10, color: '#fbbf24' }}>
                  * no probability term — this total is not comparable with the others.
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div style={{ marginTop: 12, fontSize: 10, color: 'var(--text-muted)' }}>
        P(ITM) is the model&apos;s risk-neutral probability of finishing in the money under the IV and rate above.
        It is not a probability of profit — it does not net off the premium — and it is not a forecast.
      </div>
    </div>
  )
}

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: '0.08em', fontWeight: 600, marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color, fontFamily: "'JetBrains Mono', monospace" }}>{value}</div>
      {sub && <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 1 }}>{sub}</div>}
    </div>
  )
}
