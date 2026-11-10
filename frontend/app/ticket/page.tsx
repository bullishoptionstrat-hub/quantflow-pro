'use client'
import { useMemo, useState, type CSSProperties } from 'react'
import { CONTRACT_SPECS, SPEC_SOURCE, specFor } from '@/lib/contractSpecs'
import { etClock, useMarketSession } from '@/lib/marketSession'
import { createEntry, etDate, priorAttempts, stopOutsOn } from '@/lib/journal'
import { useJournal } from '@/lib/journalStore'
import type { Side, SizingSpec } from '@/lib/riskSize'
import {
  MODELS, NARRATIVE_FIELDS, SESSION_PROFILES, STRICT_MIN_R,
  evaluateTicket, ticketRecord, visibleGates,
  type AnsweredGateId, type Answer, type DecisionState, type ModelId, type Narrative,
  type SessionProfileId, type TargetKind, type TicketInput,
} from '@/lib/tradeTicket'

/**
 * Trade ticket: the God's Plan gates, then the size.
 *
 * Nothing on this page is pre-answered. There is no default instrument, no
 * default direction, no default budget, cost or slippage, and every gate starts
 * unanswered. The one default is the 2R minimum, which is the strict profile's
 * rule and can only be raised. The ticket places no order.
 */

const MONO = "'JetBrains Mono', monospace"
const LABEL: CSSProperties = { fontSize: 10, color: 'var(--text-muted)', display: 'block', marginBottom: 4, fontWeight: 600, letterSpacing: '0.08em' }
const INPUT: CSSProperties = { width: '100%', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 4, padding: '6px 8px', color: '#fafafa', fontFamily: MONO, fontSize: 12 }

function parseField(v: string): number | null {
  const t = v.trim()
  if (t === '') return null
  return Number(t)
}

const STATE_STYLE: Record<DecisionState, { label: string; color: string; bg: string; line: string }> = {
  NEUTRAL:          { label: 'NEUTRAL — WAITING',  color: '#a1a1aa', bg: 'rgba(161,161,170,0.12)', line: 'No direction chosen. Bias is earned, not assumed.' },
  WAIT_FOR_TRIGGER: { label: 'WAIT FOR TRIGGER',   color: '#fbbf24', bg: 'rgba(251,191,36,0.12)',  line: 'Not every required item is answered or measurable yet.' },
  BLOCKED:          { label: 'BLOCKED',            color: '#ef4444', bg: 'rgba(239,68,68,0.12)',   line: 'A required gate failed. No trade on this idea as it stands.' },
  NO_TRADE:         { label: 'NO TRADE · NO SIZE', color: '#f97316', bg: 'rgba(249,115,22,0.12)',  line: 'One unit risks more than the budget. It is not rounded up.' },
  APPROVED_TRADE:   { label: 'APPROVED TRADE',     color: '#22c55e', bg: 'rgba(34,197,94,0.12)',   line: 'Every required gate passed and the idea meets the minimum R. This places no order.' },
}

const EMPTY_NARRATIVE: Narrative = {
  htfContext: '', poi: '', liquidityEvent: '', invalidation: '', cancelCondition: '', managementPlan: '', screenshot: '',
}

interface TargetRow { price: string; share: string; kind: TargetKind | '' }

function NumField({ id, label, value, onChange, placeholder }: {
  id: string; label: string; value: string; onChange: (v: string) => void; placeholder?: string
}) {
  return (
    <div style={{ flex: 1, minWidth: 130 }}>
      <label htmlFor={id} style={LABEL}>{label}</label>
      <input id={id} type="number" inputMode="decimal" step="any" value={value} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)} style={INPUT} />
    </div>
  )
}

function TextField({ id, label, value, onChange, placeholder, multiline }: {
  id: string; label: string; value: string; onChange: (v: string) => void; placeholder?: string; multiline?: boolean
}) {
  return (
    <div style={{ flex: 1, minWidth: 220 }}>
      <label htmlFor={id} style={LABEL}>{label}</label>
      {multiline
        ? <textarea id={id} rows={2} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} style={{ ...INPUT, resize: 'vertical' }} />
        : <input id={id} type="text" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} style={INPUT} />}
    </div>
  )
}

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function TicketPage() {
  const [symbol, setSymbol] = useState('')
  const [customTickSize, setCustomTickSize] = useState('')
  const [customTickValue, setCustomTickValue] = useState('')
  const [customUnit, setCustomUnit] = useState<'contract' | 'share'>('contract')
  const [contract, setContract] = useState('')
  const [side, setSide] = useState<Side | null>(null)
  const [setupId, setSetupId] = useState('')
  const [model, setModel] = useState<ModelId | ''>('')
  const [profile, setProfile] = useState<SessionProfileId | ''>('')
  const [alsoRequire, setAlsoRequire] = useState({ candle23: false, cisd: false })
  const [answers, setAnswers] = useState<Partial<Record<AnsweredGateId, Answer>>>({})
  const [narrative, setNarrative] = useState<Narrative>(EMPTY_NARRATIVE)
  const [entry, setEntry] = useState('')
  const [stop, setStop] = useState('')
  const [targets, setTargets] = useState<TargetRow[]>([{ price: '', share: '100', kind: '' }])
  const [budget, setBudget] = useState('')
  const [cost, setCost] = useState('')
  const [slippage, setSlippage] = useState('')
  const [minR, setMinR] = useState(String(STRICT_MIN_R))
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle')

  const [saveMsg, setSaveMsg] = useState<string | null>(null)

  const { panel } = useMarketSession()
  const clock = panel.status === 'ok' ? panel.data : null
  const journal = useJournal()
  const journalCtx = useMemo(() => {
    if (!journal.ready || journal.error) return null
    return {
      priorAttempts: priorAttempts(journal.entries, setupId),
      stopOutsToday: stopOutsOn(journal.entries, etDate(new Date().toISOString()) ?? ''),
    }
  }, [journal.ready, journal.error, journal.entries, setupId])

  const preset = symbol === '' || symbol === 'CUSTOM' ? undefined : specFor(symbol)

  const input: TicketInput = useMemo(() => {
    const spec: SizingSpec | null = symbol === ''
      ? null
      : preset
        ? { tickSize: preset.tickSize, tickValue: preset.tickValue, unit: preset.unit, micro: preset.micro }
        : { tickSize: parseField(customTickSize) ?? NaN, tickValue: parseField(customTickValue) ?? NaN, unit: customUnit }
    const filled = targets.filter((t) => t.price.trim() !== '')
    return {
      symbol, spec, contract, side, setupId,
      model: model === '' ? null : model,
      sessionProfile: profile === '' ? null : profile,
      alsoRequire, answers, narrative,
      entry: parseField(entry), stop: parseField(stop),
      targets: filled.map((t) => ({
        price: Number(t.price),
        share: filled.length === 1 && t.share.trim() === '' ? undefined : (parseField(t.share) ?? NaN) / 100,
        kind: t.kind === '' ? null : t.kind,
      })),
      riskBudget: parseField(budget), costPerUnit: parseField(cost), slippageTicks: parseField(slippage),
      minR: parseField(minR) ?? NaN,
      clock: clock ? { state: clock.state, nowMinutesEt: clock.nowMinutesEt, closeMinutesEt: clock.closeMinutesEt } : null,
      journal: journalCtx,
    }
  }, [symbol, preset, customTickSize, customTickValue, customUnit, contract, side, setupId, model, profile, alsoRequire, answers, narrative, entry, stop, targets, budget, cost, slippage, minR, clock, journalCtx])

  const result = useMemo(() => evaluateTicket(input), [input])
  const gates = visibleGates(input)
  const unit = input.spec?.unit ?? 'contract'
  const style = STATE_STYLE[result.state]
  const modelRequires = new Set(input.model ? MODELS[input.model].requires : [])

  const answer = (id: AnsweredGateId, a: Answer) =>
    setAnswers((cur) => {
      const next = { ...cur }
      if (next[id] === a) delete next[id]
      else next[id] = a
      return next
    })
  const setTarget = (i: number, patch: Partial<TargetRow>) =>
    setTargets((ts) => ts.map((t, j) => (j === i ? { ...t, ...patch } : t)))

  const specStatus = preset ? SPEC_SOURCE.status : symbol === 'CUSTOM' ? 'CUSTOM' : 'NONE'
  const record = JSON.stringify(ticketRecord(input, result, new Date().toISOString(), specStatus), null, 2)
  const saveToJournal = () => {
    const spec = input.spec
    if (!spec) { setSaveMsg('Choose an instrument first.'); return }
    const now = new Date().toISOString()
    const made = createEntry(ticketRecord(input, result, now, specStatus), { tickSize: spec.tickSize, tickValue: spec.tickValue, unit: spec.unit }, now)
    if ('error' in made) { setSaveMsg(made.error); return }
    const err = journal.update((es) => [...es, made.entry])
    setSaveMsg(err ?? `Saved to the journal as ${made.entry.ticket.setupId}, ${result.state}.`)
  }
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard')
      await navigator.clipboard.writeText(record)
      setCopied('copied')
    } catch {
      setCopied('failed')
    }
  }

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: '#fafafa', marginBottom: 4 }}>🧾 Trade Ticket</h1>
        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          The God&apos;s Plan gates, then the size. Every gate starts unanswered and nothing is assumed. The confluence
          score ranks ideas; it never approves one. The ticket places no order. Not investment advice.
        </p>
      </div>

      <div className="card" style={{ padding: 16, marginBottom: 16 }} aria-live="polite">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
          <span data-testid="ticket-state" style={{ color: style.color, background: style.bg, fontWeight: 800, fontSize: 13, padding: '4px 12px', borderRadius: 4, fontFamily: MONO }}>
            {style.label}
          </span>
          <span data-testid="ticket-score" title="Ranking only. A score never overrides a required gate."
            style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-secondary)' }}>
            SCORE {result.score.value}/{result.score.of} · ranking only
          </span>
          <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)' }}>
            ET clock {clock ? etClock(clock.nowMinutesEt) : '—'} (backend)
          </span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>{style.line}</div>

        {result.blockers.length > 0 && (
          <ul data-testid="blockers" style={{ margin: '0 0 8px', paddingLeft: 18, color: '#fca5a5', fontSize: 12 }}>
            {result.blockers.map((b) => <li key={b.code}><code style={{ fontFamily: MONO }}>{b.code}</code> — {b.reason}</li>)}
          </ul>
        )}
        {result.state !== 'NEUTRAL' && result.waiting.length > 0 && (
          <ul data-testid="waiting" style={{ margin: '0 0 8px', paddingLeft: 18, color: '#fcd34d', fontSize: 12 }}>
            {result.waiting.map((w) => <li key={w}>{w}</li>)}
          </ul>
        )}

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 10, fontFamily: MONO }}>
          {result.score.categories.map((c) => (
            <span key={c.name} style={{ padding: '2px 6px', borderRadius: 3, background: c.met ? 'rgba(34,197,94,0.12)' : 'var(--bg-secondary)', color: c.met ? '#22c55e' : 'var(--text-muted)' }}>
              {c.met ? '✓' : '·'} {c.name}
            </span>
          ))}
        </div>
      </div>

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#fafafa', marginBottom: 10 }}>IDEA</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
          <div style={{ minWidth: 200 }}>
            <label htmlFor="instrument" style={LABEL}>INSTRUMENT</label>
            <select id="instrument" value={symbol} onChange={(e) => setSymbol(e.target.value)} style={INPUT}>
              <option value="">Choose…</option>
              {CONTRACT_SPECS.map((s) => <option key={s.symbol} value={s.symbol}>{s.symbol} — {s.name}</option>)}
              <option value="CUSTOM">CUSTOM — enter tick size and value</option>
            </select>
          </div>
          {unit === 'contract' && symbol !== '' && (
            <TextField id="contract" label="EXACT CONTRACT" value={contract} onChange={setContract} placeholder={symbol === 'CUSTOM' ? 'e.g. ESZ6' : `e.g. ${symbol}Z6`} />
          )}
          <div role="group" aria-label="direction" style={{ display: 'flex', gap: 6 }}>
            {(['LONG', 'SHORT'] as const).map((s) => (
              <button key={s} type="button" aria-pressed={side === s} onClick={() => setSide(side === s ? null : s)}
                style={{ padding: '6px 14px', borderRadius: 4, border: '1px solid var(--border)', cursor: 'pointer', fontFamily: MONO, fontSize: 12, fontWeight: 700,
                  background: side === s ? (s === 'LONG' ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)') : 'var(--bg-secondary)',
                  color: side === s ? (s === 'LONG' ? '#22c55e' : '#ef4444') : 'var(--text-secondary)' }}>
                {s}
              </button>
            ))}
          </div>
          <TextField id="setup-id" label="SETUP / IDEA ID" value={setupId} onChange={setSetupId} />
        </div>

        {preset && (
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: MONO, marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span>{preset.symbol} · tick {preset.tickSize} = {money(preset.tickValue)} per {preset.unit}</span>
            <span title={`${SPEC_SOURCE.basis} ${SPEC_SOURCE.instruction}`}
              style={{ background: 'rgba(251,191,36,0.15)', color: '#fbbf24', fontSize: 9, fontWeight: 700, borderRadius: 3, padding: '1px 5px' }}>
              SPEC {SPEC_SOURCE.status}
            </span>
          </div>
        )}
        {symbol === 'CUSTOM' && (
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
            <NumField id="tick-size" label="TICK SIZE" value={customTickSize} onChange={setCustomTickSize} />
            <NumField id="tick-value" label="TICK VALUE ($ PER UNIT)" value={customTickValue} onChange={setCustomTickValue} />
            <div style={{ minWidth: 130 }}>
              <label htmlFor="unit" style={LABEL}>UNIT</label>
              <select id="unit" value={customUnit} onChange={(e) => setCustomUnit(e.target.value as 'contract' | 'share')} style={INPUT}>
                <option value="contract">contract</option>
                <option value="share">share</option>
              </select>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ minWidth: 240 }}>
            <label htmlFor="model" style={LABEL}>MODEL</label>
            <select id="model" value={model} onChange={(e) => setModel(e.target.value as ModelId | '')} style={INPUT}>
              <option value="">Choose…</option>
              {(Object.keys(MODELS) as ModelId[]).map((m) => <option key={m} value={m}>{MODELS[m].label}</option>)}
            </select>
          </div>
          <div style={{ minWidth: 200 }}>
            <label htmlFor="profile" style={LABEL}>SESSION PROFILE</label>
            <select id="profile" value={profile} onChange={(e) => setProfile(e.target.value as SessionProfileId | '')} style={INPUT}>
              <option value="">Choose…</option>
              {(Object.keys(SESSION_PROFILES) as SessionProfileId[]).map((p) => (
                <option key={p} value={p}>
                  {SESSION_PROFILES[p].label} — {SESSION_PROFILES[p].windows.map((w) => `${w.name} ${w.from}–${w.to}`).join(', ')} ET
                </option>
              ))}
            </select>
          </div>
          {(['candle23', 'cisd'] as const).map((g) => (
            <label key={g} style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={alsoRequire[g] || modelRequires.has(g)} disabled={modelRequires.has(g)}
                onChange={(e) => setAlsoRequire((cur) => ({ ...cur, [g]: e.target.checked }))} />
              Also require {g === 'candle23' ? 'Candle 2/3 closure' : 'LTF CISD'}{modelRequires.has(g) ? ' (required by model)' : ''}
            </label>
          ))}
        </div>
      </div>

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#fafafa', marginBottom: 4 }}>GATES</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
          Your observations, recorded as yours. Pass only what has closed and you can point to on the chart. Click an answer again to clear it.
        </div>
        {gates.map(({ def, required }) => {
          const a = answers[def.id]
          return (
            <div key={def.id} data-testid={`gate-${def.id}`} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 0', borderTop: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                {(['PASS', 'FAIL'] as const).map((v) => (
                  <button key={v} type="button" aria-pressed={a === v} aria-label={`${def.title}: ${v.toLowerCase()}`}
                    onClick={() => answer(def.id, v)}
                    style={{ padding: '3px 8px', borderRadius: 3, border: '1px solid var(--border)', cursor: 'pointer', fontFamily: MONO, fontSize: 10, fontWeight: 700,
                      background: a === v ? (v === 'PASS' ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)') : 'var(--bg-secondary)',
                      color: a === v ? (v === 'PASS' ? '#22c55e' : '#ef4444') : 'var(--text-secondary)' }}>
                    {v}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 12 }}>
                <div style={{ color: '#fafafa', fontWeight: 600 }}>
                  {def.title}{' '}
                  <code style={{ fontFamily: MONO, fontSize: 10, color: 'var(--text-muted)' }}>{def.code}</code>{' '}
                  <span style={{ fontSize: 10, color: required ? '#fbbf24' : 'var(--text-muted)' }}>{required ? 'REQUIRED' : 'optional — recorded, does not gate'}</span>
                </div>
                <div style={{ color: 'var(--text-secondary)' }}>Pass: {def.pass}</div>
                <div style={{ color: 'var(--text-muted)' }}>Fail: {def.fail}</div>
              </div>
            </div>
          )
        })}
        {result.gates.filter((g) => g.source === 'COMPUTED').map((g) => (
          <div key={g.id} data-testid={`gate-${g.id}`} style={{ display: 'flex', gap: 10, padding: '8px 0', borderTop: '1px solid var(--border)', fontSize: 12 }}>
            <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, minWidth: 92,
              color: g.status === 'PASS' ? '#22c55e' : g.status === 'FAIL' ? '#ef4444' : '#a1a1aa' }}>
              {g.status}
            </span>
            <div>
              <div style={{ color: '#fafafa', fontWeight: 600 }}>
                {g.title} <code style={{ fontFamily: MONO, fontSize: 10, color: 'var(--text-muted)' }}>{g.code}</code>{' '}
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>measured here</span>
              </div>
              <div style={{ color: 'var(--text-secondary)' }}>{g.detail}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#fafafa', marginBottom: 10 }}>PLAN</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
          {NARRATIVE_FIELDS.map((f) => (
            <TextField key={f.key} id={`n-${f.key}`} label={f.label.toUpperCase()} value={narrative[f.key]}
              multiline={f.key !== 'screenshot'} placeholder={f.key === 'screenshot' ? 'link or file name' : undefined}
              onChange={(v) => setNarrative((cur) => ({ ...cur, [f.key]: v }))} />
          ))}
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
          <NumField id="entry" label="ENTRY" value={entry} onChange={setEntry} />
          <NumField id="stop" label="STOP / INVALIDATION" value={stop} onChange={setStop} />
          <NumField id="budget" label="RISK BUDGET ($ THIS IDEA MAY LOSE)" value={budget} onChange={setBudget} />
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
          <NumField id="cost" label={`ROUND-TRIP COST ($ PER ${unit.toUpperCase()})`} value={cost} onChange={setCost} placeholder="0 if none" />
          <NumField id="slippage" label="STOP SLIPPAGE (TICKS)" value={slippage} onChange={setSlippage} placeholder="0 if none" />
          <NumField id="min-r" label={`MIN NET R (≥ ${STRICT_MIN_R})`} value={minR} onChange={setMinR} />
        </div>
        {targets.map((t, i) => (
          <div key={i} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 8 }}>
            <NumField id={`tp${i + 1}`} label={`TP${i + 1} PRICE`} value={t.price} onChange={(v) => setTarget(i, { price: v })} />
            <NumField id={`tp${i + 1}-share`} label={`TP${i + 1} SHARE %`} value={t.share} onChange={(v) => setTarget(i, { share: v })} />
            <div style={{ minWidth: 150 }}>
              <label htmlFor={`tp${i + 1}-kind`} style={LABEL}>{`TP${i + 1} LIQUIDITY`}</label>
              <select id={`tp${i + 1}-kind`} value={t.kind} onChange={(e) => setTarget(i, { kind: e.target.value as TargetKind | '' })} style={INPUT}>
                <option value="">Choose…</option>
                <option value="INTERNAL">internal</option>
                <option value="EXTERNAL">external</option>
              </select>
            </div>
            {targets.length > 1 && (
              <button type="button" onClick={() => setTargets((ts) => ts.filter((_, j) => j !== i))}
                style={{ padding: '6px 10px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 11 }}>
                Remove
              </button>
            )}
          </div>
        ))}
        {targets.length < 3 && (
          <button type="button" onClick={() => setTargets((ts) => [...ts, { price: '', share: '', kind: '' }])}
            style={{ padding: '6px 10px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: '#a78bfa', cursor: 'pointer', fontSize: 11 }}>
            + Add target
          </button>
        )}

        {result.sizing && result.sizing.verdict !== 'INVALID' && (
          <div data-testid="ticket-size" style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 14, fontFamily: MONO, fontSize: 12, color: 'var(--text-secondary)' }}>
            <span>STOP {+result.sizing.stopPoints.toFixed(6)} pts · {result.sizing.stopTicks} ticks</span>
            <span>LOSS/{unit.toUpperCase()} {money(result.sizing.lossPerUnit)}</span>
            <span>SIZE {result.sizing.units} {unit}{result.sizing.units === 1 ? '' : 's'}</span>
            <span>RISK {money(result.sizing.plannedRisk)}</span>
            <span>NET R {result.sizing.blendedNetR === null ? '—' : result.sizing.blendedNetR.toFixed(2)}</span>
          </div>
        )}
        {result.sizing && result.sizing.warnings.length > 0 && (
          <ul style={{ margin: '8px 0 0', paddingLeft: 18, color: '#fcd34d', fontSize: 12 }}>
            {result.sizing.warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        )}
      </div>

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#fafafa' }}>TICKET RECORD</div>
          <button type="button" onClick={() => void copy()}
            style={{ padding: '4px 10px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: '#a78bfa', cursor: 'pointer', fontSize: 11 }}>
            Copy JSON
          </button>
          <button type="button" onClick={saveToJournal} disabled={result.state === 'NEUTRAL'}
            title="Saves this ticket, as it stands, to the journal in this browser. Blocked ideas are worth keeping too."
            style={{ padding: '4px 10px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: result.state === 'NEUTRAL' ? 'var(--text-muted)' : '#22c55e', cursor: result.state === 'NEUTRAL' ? 'not-allowed' : 'pointer', fontSize: 11 }}>
            Save to journal
          </button>
          {saveMsg && <span data-testid="save-msg" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{saveMsg}</span>}
          {copied === 'copied' && <span style={{ fontSize: 11, color: '#22c55e' }}>Copied.</span>}
          {copied === 'failed' && <span style={{ fontSize: 11, color: '#fca5a5' }}>The browser refused the clipboard; select the text below instead.</span>}
        </div>
        <textarea data-testid="ticket-json" readOnly value={record} rows={10}
          style={{ ...INPUT, fontSize: 11, color: 'var(--text-secondary)', resize: 'vertical' }} />
      </div>

      <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
        What this measures: the session window (on the backend&apos;s ET clock and holiday calendar) and the net reward
        (after your costs, on the whole-unit split). Everything else is your own observation. The exact contract is
        checked for format and root only, not for whether that month is listed or is the front month. Holiday futures
        hours are not in this terminal&apos;s calendar, so the session gate waits on a holiday rather than guess.
      </div>
    </div>
  )
}
