'use client'
import { useMemo, useState } from 'react'
import { CONTRACT_SPECS, SPEC_SOURCE, specFor } from '@/lib/contractSpecs'
import { sizePosition, type Side, type SizingResult, type Verdict } from '@/lib/riskSize'

/**
 * Risk & position size for one idea.
 *
 * Every number on this page is either typed by the trader or derived from what
 * they typed. There is no default account size, no default cost and no default
 * slippage: an empty field is an unanswered question, and the result says
 * which one rather than sizing against a figure nobody chose. The one default
 * is the minimum R, which is a stated policy (2R) and is editable.
 */

const MONO = "'JetBrains Mono', monospace"

/** '' is "not entered", which is different from 0. */
function parseField(v: string): number | null {
  const t = v.trim()
  if (t === '') return null
  return Number(t)
}

const VERDICT_STYLE: Record<Verdict, { label: string; color: string; bg: string }> = {
  INVALID:     { label: 'CANNOT SIZE',     color: '#a1a1aa', bg: 'rgba(161,161,170,0.12)' },
  NO_SIZE:     { label: 'NO SIZE · PASS',  color: '#ef4444', bg: 'rgba(239,68,68,0.12)' },
  NO_TARGET:   { label: 'SIZED · NO TARGET', color: '#fbbf24', bg: 'rgba(251,191,36,0.12)' },
  BELOW_MIN_R: { label: 'BELOW MIN R',     color: '#f97316', bg: 'rgba(249,115,22,0.12)' },
  MEETS_MIN_R: { label: 'MEETS MIN R',     color: '#22c55e', bg: 'rgba(34,197,94,0.12)' },
}

function Field({ id, label, value, onChange, placeholder, step }: {
  id: string; label: string; value: string; onChange: (v: string) => void; placeholder?: string; step?: string
}) {
  return (
    <div style={{ flex: 1, minWidth: 140 }}>
      <label htmlFor={id} style={{ fontSize: 10, color: 'var(--text-muted)', display: 'block', marginBottom: 4, fontWeight: 600, letterSpacing: '0.08em' }}>
        {label}
      </label>
      <input
        id={id} type="number" inputMode="decimal" step={step ?? 'any'} value={value}
        placeholder={placeholder} onChange={(e) => onChange(e.target.value)}
        style={{ width: '100%', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 4, padding: '6px 8px', color: '#fafafa', fontFamily: MONO, fontSize: 12 }}
      />
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ minWidth: 110 }}>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, letterSpacing: '0.08em' }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: color ?? '#fafafa', fontFamily: MONO }}>{value}</div>
    </div>
  )
}

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const r = (n: number) => `${n.toFixed(2)}R`

interface TargetRow { price: string; share: string }

export default function RiskPage() {
  const [symbol, setSymbol] = useState<string>('ES')
  const [customTickSize, setCustomTickSize] = useState('')
  const [customTickValue, setCustomTickValue] = useState('')
  const [customUnit, setCustomUnit] = useState<'contract' | 'share'>('contract')
  const [side, setSide] = useState<Side>('LONG')
  const [entry, setEntry] = useState('')
  const [stop, setStop] = useState('')
  const [targets, setTargets] = useState<TargetRow[]>([{ price: '', share: '100' }])
  const [budget, setBudget] = useState('')
  const [cost, setCost] = useState('')
  const [slippage, setSlippage] = useState('')
  const [minR, setMinR] = useState('2')

  const preset = symbol === 'CUSTOM' ? undefined : specFor(symbol)

  const result: SizingResult | null = useMemo(() => {
    const e = parseField(entry)
    const s = parseField(stop)
    if (e === null || s === null) return null
    const spec = preset
      ? { tickSize: preset.tickSize, tickValue: preset.tickValue, unit: preset.unit, micro: preset.micro }
      : { tickSize: parseField(customTickSize) ?? NaN, tickValue: parseField(customTickValue) ?? NaN, unit: customUnit }
    const filled = targets.filter((t) => t.price.trim() !== '')
    return sizePosition({
      spec, side, entry: e, stop: s,
      targets: filled.map((t) => ({
        price: Number(t.price),
        share: filled.length === 1 && t.share.trim() === '' ? undefined : (parseField(t.share) ?? NaN) / 100,
      })),
      riskBudget: parseField(budget),
      costPerUnit: parseField(cost),
      slippageTicks: parseField(slippage),
      minR: parseField(minR) ?? NaN,
    })
  }, [preset, customTickSize, customTickValue, customUnit, side, entry, stop, targets, budget, cost, slippage, minR])

  const unitWord = preset?.unit ?? customUnit
  const setTarget = (i: number, patch: Partial<TargetRow>) =>
    setTargets((ts) => ts.map((t, j) => (j === i ? { ...t, ...patch } : t)))

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: '#fafafa', marginBottom: 4 }}>🎯 Risk &amp; Position Size</h1>
        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Sizes one idea from its stop: ticks × tick value, plus your costs and stop slippage, floored to whole units.
          Nothing here is assumed — the budget, costs and slippage are yours to enter. Not investment advice.
        </p>
      </div>

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
          <div style={{ minWidth: 200 }}>
            <label htmlFor="instrument" style={{ fontSize: 10, color: 'var(--text-muted)', display: 'block', marginBottom: 4, fontWeight: 600, letterSpacing: '0.08em' }}>INSTRUMENT</label>
            <select id="instrument" value={symbol} onChange={(e) => setSymbol(e.target.value)}
              style={{ width: '100%', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 4, padding: '6px 8px', color: '#fafafa', fontFamily: MONO, fontSize: 12 }}>
              {CONTRACT_SPECS.map((s) => <option key={s.symbol} value={s.symbol}>{s.symbol} — {s.name}</option>)}
              <option value="CUSTOM">CUSTOM — enter tick size and value</option>
            </select>
          </div>
          <div role="group" aria-label="side" style={{ display: 'flex', gap: 6 }}>
            {(['LONG', 'SHORT'] as const).map((s) => (
              <button key={s} type="button" aria-pressed={side === s} onClick={() => setSide(s)}
                style={{ padding: '6px 14px', borderRadius: 4, border: '1px solid var(--border)', cursor: 'pointer', fontFamily: MONO, fontSize: 12, fontWeight: 700,
                  background: side === s ? (s === 'LONG' ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)') : 'var(--bg-secondary)',
                  color: side === s ? (s === 'LONG' ? '#22c55e' : '#ef4444') : 'var(--text-secondary)' }}>
                {s}
              </button>
            ))}
          </div>
        </div>

        {preset ? (
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: MONO, marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span>{preset.symbol} · {preset.venue} · tick {preset.tickSize} = {money(preset.tickValue)} · {money(preset.pointValue)}/pt per {preset.unit}</span>
            <span title={`${SPEC_SOURCE.basis} ${SPEC_SOURCE.instruction}`}
              style={{ background: 'rgba(251,191,36,0.15)', color: '#fbbf24', fontSize: 9, fontWeight: 700, borderRadius: 3, padding: '1px 5px' }}>
              SPEC {SPEC_SOURCE.status}
            </span>
            <span style={{ color: 'var(--text-muted)' }}>{SPEC_SOURCE.instruction}</span>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
            <Field id="tick-size" label="TICK SIZE" value={customTickSize} onChange={setCustomTickSize} placeholder="e.g. 0.25" />
            <Field id="tick-value" label="TICK VALUE ($ PER UNIT)" value={customTickValue} onChange={setCustomTickValue} placeholder="e.g. 12.50" />
            <div style={{ minWidth: 140 }}>
              <label htmlFor="unit" style={{ fontSize: 10, color: 'var(--text-muted)', display: 'block', marginBottom: 4, fontWeight: 600, letterSpacing: '0.08em' }}>UNIT</label>
              <select id="unit" value={customUnit} onChange={(e) => setCustomUnit(e.target.value as 'contract' | 'share')}
                style={{ width: '100%', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 4, padding: '6px 8px', color: '#fafafa', fontFamily: MONO, fontSize: 12 }}>
                <option value="contract">contract</option>
                <option value="share">share</option>
              </select>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
          <Field id="entry" label="ENTRY" value={entry} onChange={setEntry} />
          <Field id="stop" label="STOP / INVALIDATION" value={stop} onChange={setStop} />
          <Field id="budget" label="RISK BUDGET ($ THIS IDEA MAY LOSE)" value={budget} onChange={setBudget} />
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
          <Field id="cost" label={`ROUND-TRIP COST ($ PER ${unitWord.toUpperCase()})`} value={cost} onChange={setCost} placeholder="0 if none" />
          <Field id="slippage" label="STOP SLIPPAGE (TICKS)" value={slippage} onChange={setSlippage} placeholder="0 if none" />
          <Field id="min-r" label="MIN NET R (POLICY)" value={minR} onChange={setMinR} />
        </div>

        <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, letterSpacing: '0.08em', marginBottom: 4 }}>TARGETS</div>
        {targets.map((t, i) => (
          <div key={i} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 8 }}>
            <Field id={`tp${i + 1}`} label={`TP${i + 1} PRICE`} value={t.price} onChange={(v) => setTarget(i, { price: v })} />
            <Field id={`tp${i + 1}-share`} label={`TP${i + 1} SHARE %`} value={t.share} onChange={(v) => setTarget(i, { share: v })} />
            {targets.length > 1 && (
              <button type="button" onClick={() => setTargets((ts) => ts.filter((_, j) => j !== i))}
                style={{ padding: '6px 10px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 11 }}>
                Remove
              </button>
            )}
          </div>
        ))}
        {targets.length < 3 && (
          <button type="button" onClick={() => setTargets((ts) => [...ts, { price: '', share: '' }])}
            style={{ padding: '6px 10px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: '#a78bfa', cursor: 'pointer', fontSize: 11 }}>
            + Add target
          </button>
        )}
      </div>

      <div className="card" style={{ padding: 16, marginBottom: 16 }} aria-live="polite">
        {result === null ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Enter an entry and a stop to size the idea.</div>
        ) : (
          <Results result={result} unit={unitWord} />
        )}
      </div>

      <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
        Assumptions: slippage is charged on the stop only (a stop exits at market, a target rests as a limit); costs are
        charged on both the loss and every reward; an off-grid stop is rounded to more ticks and an off-grid target to
        fewer. This sizes one idea against one stop. It does not know your daily loss limit, open correlated risk or a
        prop firm&apos;s drawdown floor — the stricter limit wins, and checking it is yours.
      </div>
    </div>
  )
}

function Results({ result, unit }: { result: SizingResult; unit: string }) {
  const v = VERDICT_STYLE[result.verdict]
  const sized = result.verdict !== 'INVALID'
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <span data-testid="verdict" style={{ color: v.color, background: v.bg, fontWeight: 800, fontSize: 12, padding: '3px 10px', borderRadius: 4, fontFamily: MONO }}>
          {v.label}
        </span>
      </div>

      {result.errors.length > 0 && (
        <ul style={{ margin: '0 0 12px', paddingLeft: 18, color: '#fca5a5', fontSize: 12 }}>
          {result.errors.map((e) => <li key={e}>{e}</li>)}
        </ul>
      )}
      {result.warnings.length > 0 && (
        <ul style={{ margin: '0 0 12px', paddingLeft: 18, color: '#fcd34d', fontSize: 12 }}>
          {result.warnings.map((w) => <li key={w}>{w}</li>)}
        </ul>
      )}

      {sized && (
        <>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 14 }}>
            {/* toFixed(6) then back to a number: 30 ticks × 0.005 is 0.15000000000000002 in float. */}
            <Stat label="STOP" value={`${+result.stopPoints.toFixed(6)} pts · ${result.stopTicks} ticks`} />
            <Stat label={`LOSS / ${unit.toUpperCase()}`} value={money(result.lossPerUnit)} color="#ef4444" />
            <Stat label="SIZE" value={`${result.units} ${unit}${result.units === 1 ? '' : 's'}`} color="#a78bfa" />
            <Stat label="RISK AT STOP" value={money(result.plannedRisk)} color="#ef4444" />
            <Stat label="BUDGET UNUSED" value={money(result.budgetUnused)} />
            <Stat label="BLENDED NET R" value={result.blendedNetR === null ? '—' : r(result.blendedNetR)}
              color={result.verdict === 'MEETS_MIN_R' ? '#22c55e' : result.verdict === 'BELOW_MIN_R' ? '#f97316' : undefined} />
          </div>

          {result.targets.length > 0 && (
            <table style={{ width: '100%', fontSize: 12, fontFamily: MONO, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: 'var(--text-muted)', textAlign: 'left', fontSize: 10 }}>
                  <th style={{ padding: '4px 6px' }}>TARGET</th><th>PRICE</th><th>TICKS</th><th>GROSS R</th>
                  <th>NET $ / {unit.toUpperCase()}</th><th>NET R</th><th>SHARE</th><th>{unit.toUpperCase()}S</th>
                </tr>
              </thead>
              <tbody>
                {result.targets.map((t, i) => (
                  <tr key={i} style={{ borderTop: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                    <td style={{ padding: '4px 6px' }}>TP{i + 1}{t.offGrid ? ' *' : ''}</td>
                    <td>{t.price}</td><td>{t.ticks}</td><td>{r(t.grossR)}</td>
                    <td>{money(t.netRewardPerUnit)}</td><td>{r(t.netR)}</td>
                    <td>{Math.round(t.share * 100)}%</td><td>{t.units}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  )
}
