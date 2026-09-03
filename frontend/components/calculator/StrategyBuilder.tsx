'use client'
import { useState, useMemo, useEffect, useRef } from 'react'
import { ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer } from 'recharts'
import { blackScholes, computePLCurve } from '@/lib/blackScholes'
import { expiryPayoff, extremes, breakevens, netCost } from '@/lib/payoff'
import { useStore } from '@/store/useStore'
import { useSpotQuotes, isStale, asOf } from '@/lib/spotQuotes'
import { spotPrice as fmtSpot } from '@/lib/format'
import type { StrategyLeg } from '@/lib/types'

/**
 * Every strategy was priced off a hardcoded 2024 price map.
 *
 * `SPOTS` held SPY 557, NVDA 942, SPX 5587 — the ticker tape's base map again,
 * a third copy after the tape's and the watchlist's — and seeded both the spot
 * input and the first leg's strike from it. A user switching to NVDA got a
 * Black-Scholes price computed at 942 with nothing on screen saying where 942
 * came from or when.
 *
 * It was also read **once**, into `useState`'s initial value, so changing the
 * selected ticker afterwards left the previous underlying's spot and strike in
 * place. The builder said NVDA at the top and priced SPY underneath.
 *
 * The spot now seeds from `/api/macro/quotes`, is re-seeded when the ticker
 * changes, and says which quote it came from and when. With no quote there is
 * no substitute: the builder asks for a spot rather than supplying one, and
 * holds off creating a leg until it has a strike to put on it.
 */

/** A round starting strike. The connector's symbols are all above $1. */
const STRIKE_STEP = 5
const DEFAULT_IV = 30

/**
 * A leg, plus what the builder needs to know about it and the wire type does
 * not carry: a stable key, and whether its entry price is still the model's
 * guess or something the reader typed.
 *
 * `entryPrice` used to default to `0`, which made the whole curve the
 * position's *value* rather than its P/L: a long call showed a max loss of
 * zero and a breakeven of `—`, because it had cost nothing. Seeding it from
 * the model gives a real P/L on first render — but `ENTRY $` reads as what
 * you paid, so a model price sitting in it has to say so, the same way the
 * spot field names where its number came from.
 */
interface BuilderLeg extends StrategyLeg {
  key: number
  entryFromModel: boolean
}

let nextKey = 1

/** Dollars, signed, abbreviated the way the tiles always have been. */
function money(v: number): string {
  const a = Math.abs(v)
  const body = a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a > 9999 ? `${Math.round(a / 1000)}K` : a.toLocaleString()
  return v < 0 ? `$(${body})` : `$${body}`
}

/**
 * What the position cost, in three states rather than two.
 *
 * The tile read `total > 0 ? $total : 'Credit'`, and every leg's entry price
 * defaulted to `0` — so a long call, on first render, was labelled as having
 * been opened for a credit.
 */
function costLabel(cost: ReturnType<typeof netCost>): string {
  if (cost.kind === 'unset') return 'no entry set'
  if (cost.kind === 'flat') return '$0'
  return `${money(cost.amount)} ${cost.kind}`
}

function defaultLeg(spot: number, dte: number, rate: number): BuilderLeg {
  const strike = Math.max(STRIKE_STEP, Math.round(spot / STRIKE_STEP) * STRIKE_STEP)
  const modelPrice = blackScholes('C', {
    S: spot, K: strike, T: Math.max(dte / 365, 0.001), r: rate / 100, sigma: DEFAULT_IV / 100,
  }).price
  return {
    key: nextKey++,
    optionType: 'C', action: 'BUY', strike,
    expiry: new Date(Date.now() + dte * 86400000).toISOString().slice(0, 10),
    iv: DEFAULT_IV,
    entryPrice: Math.round(modelPrice * 100) / 100,
    entryFromModel: true,
    qty: 1,
  }
}

export function StrategyBuilder() {
  const { selectedTicker } = useStore()
  const { quote } = useSpotQuotes()
  const live = quote(selectedTicker)

  const [legs, setLegs] = useState<BuilderLeg[]>([])
  const [daysToExpiry, setDaysToExpiry] = useState(30)
  /**
   * The assumed risk-free rate, in percent. It was `r: 0.05` inline in the
   * Greeks call and a default parameter of `computePLCurve`, so the two could
   * have disagreed and neither was on screen.
   */
  const [rate, setRate] = useState(5)
  /** `null` until a quote arrives or the reader types one. Never a stand-in. */
  const [useSpot, setUseSpot] = useState<number | null>(null)
  /** Set once the reader edits the spot, so a poll does not overwrite them. */
  const edited = useRef(false)
  const seededFor = useRef<string | null>(null)

  // Re-seed when the underlying changes, and adopt the first quote that
  // arrives for it. A strategy is built on one underlying, so the legs go with
  // the spot rather than carrying SPY strikes onto an NVDA price.
  useEffect(() => {
    if (seededFor.current !== selectedTicker) {
      seededFor.current = selectedTicker
      edited.current = false
      setUseSpot(live ? live.price : null)
      setLegs(live ? [defaultLeg(live.price, daysToExpiry, rate)] : [])
      return
    }
    if (!edited.current && live && useSpot === null) {
      setUseSpot(live.price)
      setLegs(l => (l.length === 0 ? [defaultLeg(live.price, daysToExpiry, rate)] : l))
    }
  }, [selectedTicker, live, useSpot, daysToExpiry, rate])

  const addLeg = () => setLegs(l => [...l, defaultLeg(useSpot ?? 0, daysToExpiry, rate)])
  const removeLeg = (i: number) => setLegs(l => l.filter((_, j) => j !== i))
  const updateLeg = (i: number, k: keyof StrategyLeg, v: unknown) =>
    setLegs(l => l.map((leg, j) => (
      j === i
        // Typing an entry price makes it the reader's, and a later re-seed
        // must not quietly put the model's number back.
        ? { ...leg, [k]: v, entryFromModel: k === 'entryPrice' ? false : leg.entryFromModel }
        : leg
    )))

  // Compute greeks for first leg
  const greeks = useMemo(() => {
    if (!legs[0] || useSpot === null) return null
    const T = Math.max(daysToExpiry / 365, 0.001)
    return blackScholes(legs[0].optionType, { S: useSpot, K: legs[0].strike, T, r: rate / 100, sigma: legs[0].iv / 100 })
  }, [legs, useSpot, daysToExpiry, rate])

  /**
   * Two curves, because the chart was drawing one and naming the other.
   *
   * `expiry` is the payoff at settlement — the thing the heading has always
   * claimed. `today` is `computePLCurve`, the model value `daysToExpiry` from
   * now, which is what was actually plotted; it is kept because it is the
   * curve the DTE slider moves, and losing it would leave that control with
   * nothing to do.
   *
   * Empty until there is a spot to centre on: a curve drawn around a stand-in
   * price is a picture of a position nobody holds.
   */
  const plData = useMemo(() => {
    if (useSpot === null || legs.length === 0) return []
    const range = Array.from({ length: 60 }, (_, i) => useSpot * (0.7 + i * 0.01))
    const today = computePLCurve(legs, range, daysToExpiry, rate / 100)
    return range.map((price, i) => ({
      price: Math.round(price),
      today: Math.round(today[i]),
      expiry: Math.round(expiryPayoff(legs, price)),
    }))
  }, [legs, useSpot, daysToExpiry, rate])

  // Exact, from the payoff's own kinks — not from where the plotted range
  // happens to stop. `null` means the tail is unbounded.
  const { maxProfit, maxLoss } = useMemo(() => extremes(legs), [legs])
  const bes = useMemo(() => breakevens(legs), [legs])
  const cost = useMemo(() => netCost(legs), [legs])

  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)',
    borderRadius: 5, padding: '5px 8px', fontSize: 12, fontFamily: "'JetBrains Mono', monospace",
    outline: 'none', width: '100%',
  }
  const selectStyle: React.CSSProperties = { ...inputStyle }

  const CustomTooltip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null
    const d = payload[0]?.payload
    return (
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-light)', borderRadius: 6, padding: '8px 12px', fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>
        <div>PRICE: <span style={{ color: '#a78bfa', fontWeight: 700 }}>${d?.price}</span></div>
        <div>AT EXPIRY: <span style={{ color: d?.expiry >= 0 ? '#22c55e' : '#ef4444', fontWeight: 700 }}>{d?.expiry >= 0 ? '+' : ''}${d?.expiry?.toLocaleString()}</span></div>
        <div>TODAY: <span style={{ color: '#60a5fa', fontWeight: 700 }}>{d?.today >= 0 ? '+' : ''}${d?.today?.toLocaleString()}</span></div>
      </div>
    )
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: 16 }}>
      {/* Left: builder */}
      <div>
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header">
            <span style={{ fontWeight: 700, fontSize: 13 }}>STRATEGY BUILDER</span>
            {/* A leg needs a strike, and a strike is chosen around the spot.
                With no spot there is nothing to centre it on, and defaulting
                is how `SPOTS[selectedTicker] || 100` came about. */}
            <button
              onClick={addLeg}
              disabled={useSpot === null}
              title={useSpot === null ? 'Set an underlying spot first' : undefined}
              style={{ background: 'rgba(139,92,246,0.1)', border: '1px solid rgba(139,92,246,0.3)', color: '#a78bfa', fontSize: 11, padding: '4px 10px', borderRadius: 5, cursor: useSpot === null ? 'not-allowed' : 'pointer', opacity: useSpot === null ? 0.4 : 1 }}
            >
              + Add Leg
            </button>
          </div>
          <div style={{ padding: 14 }}>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 10, color: 'var(--text-muted)', marginBottom: 4, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' }}>UNDERLYING SPOT · {selectedTicker}</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="number"
                  value={useSpot ?? ''}
                  placeholder="enter a spot"
                  onChange={e => {
                    edited.current = true
                    setUseSpot(e.target.value === '' ? null : Number(e.target.value))
                  }}
                  style={inputStyle}
                />
                <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>DTE: {daysToExpiry}</span>
              </div>
              {/* Where the number came from. `SPOTS[selectedTicker] || 100`
                  said nothing, and what it seeded was a 2024 price. */}
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4, fontFamily: "'JetBrains Mono', monospace" }}>
                {edited.current && useSpot !== null
                  ? 'YOUR OWN ASSUMPTION'
                  : live
                    ? `FROM ${live.symbol} ${fmtSpot(live.price)}${isStale(live) ? ` · AS OF ${asOf(live)} ET` : ''}`
                    : `NO LIVE QUOTE FOR ${selectedTicker} — enter a spot to price against`}
              </div>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 10, color: 'var(--text-muted)', marginBottom: 4, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' }}>DAYS TO EXPIRY: {daysToExpiry}</label>
              <input type="range" min={1} max={180} value={daysToExpiry} onChange={e => setDaysToExpiry(Number(e.target.value))} style={{ width: '100%', accentColor: '#8b5cf6' }} />
            </div>
            <div style={{ marginBottom: 12 }}>
              {/* Was `r: 0.05` in the Greeks call and a default parameter of
                  `computePLCurve` — two copies of an assumed interest rate,
                  neither of them on screen. */}
              <label style={{ display: 'block', fontSize: 10, color: 'var(--text-muted)', marginBottom: 4, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' }}>RISK-FREE (assumed): {rate}%</label>
              <input type="range" min={0} max={12} step={1} value={rate} onChange={e => setRate(Number(e.target.value))} style={{ width: '100%', accentColor: '#8b5cf6' }} />
            </div>
            {legs.map((leg, i) => (
              <div key={leg.key} style={{ background: 'var(--bg-secondary)', borderRadius: 6, padding: 12, marginBottom: 10, border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#a78bfa' }}>LEG {i + 1}</span>
                  {legs.length > 1 && (
                    <button onClick={() => removeLeg(i)} style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 14 }}>✕</button>
                  )}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text-muted)', display: 'block', marginBottom: 3, fontWeight: 600, letterSpacing: '0.06em' }}>TYPE</label>
                    <select value={leg.optionType} onChange={e => updateLeg(i, 'optionType', e.target.value)} style={selectStyle}>
                      <option value="C">CALL</option>
                      <option value="P">PUT</option>
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text-muted)', display: 'block', marginBottom: 3, fontWeight: 600, letterSpacing: '0.06em' }}>ACTION</label>
                    <select value={leg.action} onChange={e => updateLeg(i, 'action', e.target.value)} style={selectStyle}>
                      <option value="BUY">BUY</option>
                      <option value="SELL">SELL</option>
                    </select>
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text-muted)', display: 'block', marginBottom: 3, fontWeight: 600, letterSpacing: '0.06em' }}>STRIKE</label>
                    <input type="number" value={leg.strike} onChange={e => updateLeg(i, 'strike', Number(e.target.value))} style={inputStyle} step={5} />
                  </div>
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text-muted)', display: 'block', marginBottom: 3, fontWeight: 600, letterSpacing: '0.06em' }}>
                      ENTRY $ {leg.entryFromModel && <span style={{ color: '#fbbf24', fontWeight: 700 }}>· MODEL</span>}
                    </label>
                    <input type="number" value={leg.entryPrice} onChange={e => updateLeg(i, 'entryPrice', Number(e.target.value))} style={inputStyle} step={0.01} min={0} />
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text-muted)', display: 'block', marginBottom: 3, fontWeight: 600, letterSpacing: '0.06em' }}>IV: {leg.iv}%</label>
                    <input type="range" min={5} max={200} value={leg.iv} onChange={e => updateLeg(i, 'iv', Number(e.target.value))} style={{ width: '100%', accentColor: '#f97316' }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text-muted)', display: 'block', marginBottom: 3, fontWeight: 600, letterSpacing: '0.06em' }}>QTY</label>
                    <input type="number" value={leg.qty} onChange={e => updateLeg(i, 'qty', Math.max(1, parseInt(e.target.value) || 1))} style={inputStyle} min={1} max={100} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Greeks */}
        {greeks && (
          <div className="card">
            <div className="card-header"><span style={{ fontWeight: 700, fontSize: 13 }}>GREEKS — LEG 1</span></div>
            <div style={{ padding: 14, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
              {[
                { label: 'PRICE', value: `$${greeks.price.toFixed(2)}`, color: '#fafafa' },
                { label: 'DELTA', value: greeks.delta.toFixed(4), color: greeks.delta >= 0 ? '#22c55e' : '#ef4444' },
                { label: 'GAMMA', value: greeks.gamma.toFixed(5), color: '#60a5fa' },
                { label: 'THETA/DAY', value: greeks.theta.toFixed(4), color: '#ef4444' },
                { label: 'VEGA/1%', value: greeks.vega.toFixed(4), color: '#fbbf24' },
                { label: 'RHO', value: greeks.rho.toFixed(4), color: 'var(--text-secondary)' },
              ].map(g => (
                <div key={g.label} style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: '0.08em', marginBottom: 4, fontWeight: 600 }}>{g.label}</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: g.color, fontFamily: "'JetBrains Mono', monospace" }}>{g.value}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Right: P/L chart + summary */}
      <div>
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 0, borderBottom: '1px solid var(--border)' }}>
            {[
              // `∞` where the tail is unbounded. `Math.min` over a 0.70x–1.29x
              // sample used to report a naked short call's max loss as a
              // finite number, which was a fact about the plotted range.
              { label: 'MAX PROFIT', value: maxProfit === null ? '∞' : money(maxProfit), color: '#22c55e' },
              { label: 'MAX LOSS', value: maxLoss === null ? '-∞' : money(maxLoss), color: '#ef4444' },
              // All of them. A straddle has two, and printing the first is a
              // wrong answer to "where do I break even".
              { label: bes.length > 1 ? 'BREAKEVENS' : 'BREAKEVEN', value: bes.length > 0 ? bes.map(b => `$${b.toLocaleString()}`).join(' / ') : '—', color: '#fbbf24' },
              { label: 'NET COST', value: costLabel(cost), color: '#a78bfa' },
            ].map(s => (
              <div key={s.label} style={{ padding: '14px 16px', borderRight: '1px solid var(--border)' }}>
                <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: '0.1em', fontWeight: 600, marginBottom: 6 }}>{s.label}</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: s.color, fontFamily: "'JetBrains Mono', monospace" }}>{s.value}</div>
              </div>
            ))}
          </div>
          <div style={{ padding: 16 }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12, fontFamily: "'JetBrains Mono', monospace" }}>
              P/L — {selectedTicker} · {legs.length} LEG{legs.length > 1 ? 'S' : ''}
              <span style={{ marginLeft: 10, color: '#22c55e' }}>■ at expiry</span>
              <span style={{ marginLeft: 8, color: '#60a5fa' }}>┄ today ({daysToExpiry}d out)</span>
            </div>
            {plData.length === 0 ? (
              <div style={{ height: 280, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', fontSize: 11, color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>
                {legs.length === 0
                  ? `NO SPOT FOR ${selectedTicker} — enter one on the left to build a strategy`
                  : 'NO SPOT — the curve has nothing to centre on'}
              </div>
            ) : (
            <ResponsiveContainer width="100%" height={280}>
              <ComposedChart data={plData} margin={{ top: 10, right: 20, left: 0, bottom: 5 }}>
                <defs>
                  <linearGradient id="plGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="plGradRed" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                <XAxis dataKey="price" tick={{ fill: '#71717a', fontSize: 10, fontFamily: 'JetBrains Mono' }} tickFormatter={v => `$${v}`} />
                <YAxis tick={{ fill: '#71717a', fontSize: 10, fontFamily: 'JetBrains Mono' }} tickFormatter={v => v >= 1000 || v <= -1000 ? `${v/1000}K` : `${v}`} />
                <Tooltip content={<CustomTooltip />} />
                <ReferenceLine y={0} stroke="#52525b" strokeWidth={1.5} />
                {useSpot !== null && (
                  <ReferenceLine x={useSpot} stroke="#a78bfa" strokeDasharray="4 4" label={{ value: 'SPOT', fill: '#a78bfa', fontSize: 10 }} />
                )}
                {bes.map((be, i) => (
                  <ReferenceLine key={i} x={be} stroke="#fbbf24" strokeDasharray="3 3" />
                ))}
                {/* The payoff at settlement — what the heading has always
                    claimed — and beneath it the model value `daysToExpiry`
                    from now, which is what used to be drawn under that name. */}
                <Area type="monotone" dataKey="expiry" name="At expiry" stroke="#22c55e" strokeWidth={2} fill="url(#plGrad)"
                  dot={false}
                  activeDot={{ r: 4 }}
                  connectNulls
                />
                <Line type="monotone" dataKey="today" name="Today" stroke="#60a5fa" strokeWidth={1.5} strokeDasharray="4 3"
                  dot={false}
                  activeDot={{ r: 3 }}
                />
              </ComposedChart>
            </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
