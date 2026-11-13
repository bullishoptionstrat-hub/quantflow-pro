'use client'
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import Link from 'next/link'
import { Panel } from '@/components/hud/Panel'
import { useMarketSession } from '@/lib/marketSession'
import { useJournal } from '@/lib/journalStore'
import { usePlans } from '@/lib/dailyPlanStore'
import { SESSION_PROFILES, type SessionProfileId } from '@/lib/tradeTicket'
import {
  DATE_UNKNOWN, LEVEL_STATUSES, LEVEL_TYPES, LIQUIDITY, SCENARIO_KEYS, SCENARIO_LABELS,
  bodyFromDraft, createPlan, dealingRange, draftFromBody, editPlan, effectiveBody, emptyDraft, eventWindow,
  isFrozen, planChecklist, planDateFrom, strictestLimits, zoneOf,
  type DailyPlan, type DraftEvent, type DraftLevel, type PlanBody, type PlanDraft, type Scenario, type ScenarioKey,
} from '@/lib/dailyPlan'

/**
 * The daily plan: the pre-session map the ticket checks before it approves.
 *
 * Every field is the trader's. Nothing is pre-filled: the bias reads NEUTRAL
 * until a direction is chosen, and the loss limit and attempts are empty until
 * written. The trading date is the backend's (`/api/health` → `session.date`);
 * with no answer the page says the date is unknown and will not create or edit
 * a plan. Past plans are records and are shown read-only.
 */

const MONO = "'JetBrains Mono', monospace"
const LABEL: CSSProperties = { fontSize: 10, color: 'var(--text-muted)', display: 'block', marginBottom: 4, fontWeight: 600, letterSpacing: '0.08em' }
const INPUT: CSSProperties = { width: '100%', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 4, padding: '6px 8px', color: 'var(--text-primary)', fontFamily: MONO, fontSize: 12 }
const BUTTON: CSSProperties = { padding: '5px 10px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--brand)', cursor: 'pointer', fontSize: 11 }
const NOTE: CSSProperties = { fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }
const CALC: CSSProperties = { fontFamily: MONO, fontSize: 12, color: 'var(--text-secondary)' }

const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const px = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 6 })

function Field({ id, label, value, onChange, placeholder, width = 140, multiline }: {
  id: string; label: string; value: string; onChange: (v: string) => void; placeholder?: string; width?: number; multiline?: boolean
}) {
  return (
    <div style={{ flex: 1, minWidth: width }}>
      <label htmlFor={id} style={LABEL}>{label}</label>
      {multiline
        ? <textarea id={id} rows={2} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} style={{ ...INPUT, resize: 'vertical' }} />
        : <input id={id} type="text" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} style={INPUT} />}
    </div>
  )
}

function Choice<T extends string>({ id, label, value, options, onChange, width = 120, render }: {
  id: string; label: string; value: T | ''; options: readonly T[]; onChange: (v: T | '') => void; width?: number; render?: (v: T) => string
}) {
  return (
    <div style={{ minWidth: width }}>
      <label htmlFor={id} style={LABEL}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as T | '')} style={INPUT}>
        <option value="">Choose…</option>
        {options.map((o) => <option key={o} value={o}>{render ? render(o) : o}</option>)}
      </select>
    </div>
  )
}

const Row = ({ children }: { children: ReactNode }) => (
  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 10 }}>{children}</div>
)

export default function PrepPage() {
  const { panel } = useMarketSession()
  const session = panel.status === 'ok' ? panel.data : null
  // The trading date is the backend's and nobody else's.
  const today = planDateFrom(session)
  const store = usePlans()
  const journal = useJournal()
  const entries = journal.ready && !journal.error ? journal.entries : null
  const todays = today ? store.plans.find((p) => p.date === today) ?? null : null

  const [draft, setDraft] = useState<PlanDraft>(emptyDraft)
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  // Load today's plan into the form once per date, after the store has read.
  useEffect(() => {
    if (!store.ready || today === null) return
    if (loadedFor === today) return
    setDraft(todays ? draftFromBody(effectiveBody(todays)) : emptyDraft())
    setLoadedFor(today)
  }, [store.ready, today, todays, loadedFor])

  const parsed = useMemo(() => bodyFromDraft(draft), [draft])
  const checklist = useMemo(() => planChecklist(parsed.body), [parsed.body])
  const range = dealingRange(parsed.body.range.high, parsed.body.range.low)
  const frozen = todays !== null && isFrozen(todays, entries)
  const past = useMemo(() => store.plans.filter((p) => p.date !== today).sort((a, b) => b.date.localeCompare(a.date)), [store.plans, today])

  const set = <K extends keyof PlanDraft>(k: K, v: PlanDraft[K]) => setDraft((d) => ({ ...d, [k]: v }))
  const setLevel = (i: number, p: Partial<DraftLevel>) => setDraft((d) => ({ ...d, levels: d.levels.map((l, j) => (j === i ? { ...l, ...p } : l)) }))
  const setEvent = (i: number, p: Partial<DraftEvent>) => setDraft((d) => ({ ...d, events: d.events.map((e, j) => (j === i ? { ...e, ...p } : e)) }))
  const setScenario = (k: ScenarioKey, p: Partial<Scenario>) => setDraft((d) => ({ ...d, scenarios: { ...d.scenarios, [k]: { ...d.scenarios[k], ...p } } }))

  const save = () => {
    if (today === null) { setMsg(DATE_UNKNOWN); return }
    if (parsed.errors.length) { setMsg(`Not saved. ${parsed.errors.join(' ')}`); return }
    const now = new Date().toISOString()
    if (!todays) {
      const made = createPlan(store.plans, today, parsed.body, now, entries)
      if ('error' in made) { setMsg(made.error); return }
      const err = store.update((ps) => [...ps, made.plan])
      setMsg(err ?? `Saved the plan for ${today}.`)
      return
    }
    const r = editPlan(todays, parsed.body, now, today, entries)
    if ('error' in r) { setMsg(r.error); return }
    if (r.result === 'UNCHANGED') { setMsg('Nothing changed since the last save.'); return }
    const err = store.update((ps) => ps.map((p) => (p.date === today ? r.plan : p)))
    setMsg(err ?? (r.result === 'AMENDED'
      ? `Recorded amendment ${r.plan.amendments.length} at ${new Date(now).toLocaleTimeString()}. The plan as written before the first trade is kept.`
      : `Saved the plan for ${today}.`))
  }

  const savedChecklist = todays ? planChecklist(todays.body) : null
  const savedMissing = savedChecklist ? savedChecklist.filter((i) => !i.done).length : null

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>📋 Daily Plan</h1>
        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          The pre-session map: levels, the dealing range, three scenarios, the events to stand aside for, and the day&apos;s
          written limits. The trade ticket waits until today&apos;s plan is written and complete, and its limits can only
          tighten the ticket. Not investment advice.
        </p>
        <p data-testid="plan-date" style={{ fontFamily: MONO, fontSize: 12, marginTop: 6, color: today ? 'var(--text-primary)' : '#fcd34d' }}>
          {today
            ? <>TRADING DATE {today} · ET · from the backend&apos;s session calendar</>
            : panel.status === 'loading'
              ? 'TRADING DATE — waiting for the backend…'
              : `TRADING DATE UNKNOWN — ${DATE_UNKNOWN}`}
        </p>
        <p style={{ fontSize: 11, color: '#fbbf24', marginTop: 4 }}>
          Stored in this browser only, beside the journal. Another browser or a cleared cache will not have it.
        </p>
      </div>

      {store.error && <div data-testid="plan-error" className="card" style={{ padding: 12, marginBottom: 16, color: '#fca5a5', fontSize: 12 }}>{store.error}</div>}
      {store.rejected > 0 && (
        <div className="card" style={{ padding: 12, marginBottom: 16, color: '#fcd34d', fontSize: 12 }}>
          {store.rejected} stored plan{store.rejected === 1 ? '' : 's'} failed the shape check or repeat a date. Kept in storage, not shown, not read by the ticket.
        </div>
      )}

      {today !== null && store.ready && (
        <>
          <Panel title="Pre-session checklist" code="BROWSER CALC" data-testid="plan-checklist"
            status={<span style={{ fontFamily: MONO, fontSize: 10, color: frozen ? '#fcd34d' : 'var(--text-muted)' }}>
              {todays === null ? 'NOT SAVED' : frozen ? 'FROZEN · EDITS ARE AMENDMENTS' : 'EDITABLE UNTIL THE FIRST TAKEN TRADE'}
            </span>}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8, marginBottom: 8 }}>
              {checklist.map((i) => (
                <div key={i.id} data-testid={`check-${i.id}`} style={{ fontSize: 12, padding: '6px 8px', borderRadius: 3, background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                  <span style={{ fontFamily: MONO, fontWeight: 700, color: i.done ? '#22c55e' : '#fbbf24' }}>{i.done ? '✓' : '·'}</span>{' '}
                  <span style={{ color: 'var(--text-primary)' }}>{i.label}</span>
                  {!i.done && <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 2 }}>{i.missing[0]}{i.missing.length > 1 ? ` (+${i.missing.length - 1} more)` : ''}</div>}
                </div>
              ))}
            </div>
            <div style={NOTE} data-testid="plan-saved-status">
              Shown as drafted. Every item is derived from its fields; none can be ticked.{' '}
              {todays === null
                ? 'Nothing is saved for today yet, so the ticket waits on PLAN_NOT_WRITTEN.'
                : savedMissing === 0
                  ? 'The ticket reads the saved plan: COMPLETE.'
                  : `The ticket reads the saved plan: INCOMPLETE, ${savedMissing} item${savedMissing === 1 ? '' : 's'} open.`}
              {frozen && ' After the first taken trade the ticket checks the plan as written before it; an amendment cannot complete it, and its limits and windows can only add restrictions.'}
            </div>
          </Panel>

          <div className="prep-grid">
            <Panel title="Focus and bias" code="TRADER INPUT">
              <Row>
                <Field id="instruments" label="INSTRUMENTS IN FOCUS" value={draft.instruments} onChange={(v) => set('instruments', v)} placeholder="e.g. ES, NQ" width={200} />
              </Row>
              <Row>
                <div>
                  <span style={LABEL}>HTF BIAS</span>
                  <div role="group" aria-label="HTF bias" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    {(['BULLISH', 'BEARISH'] as const).map((b) => (
                      <button key={b} type="button" aria-pressed={draft.htfBias === b} onClick={() => set('htfBias', draft.htfBias === b ? null : b)}
                        style={{ ...BUTTON, fontFamily: MONO, fontWeight: 700,
                          color: draft.htfBias === b ? (b === 'BULLISH' ? '#22c55e' : '#ef4444') : 'var(--text-secondary)',
                          background: draft.htfBias === b ? (b === 'BULLISH' ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)') : 'var(--bg-secondary)' }}>
                        {b}
                      </button>
                    ))}
                    <span data-testid="plan-bias" style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)' }}>
                      {draft.htfBias ?? 'NEUTRAL — no bias chosen'}
                    </span>
                  </div>
                </div>
              </Row>
              <Row>
                <Choice id="plan-profile" label="SESSION PROFILE" value={draft.sessionProfile} width={260}
                  options={Object.keys(SESSION_PROFILES) as SessionProfileId[]}
                  render={(p) => `${SESSION_PROFILES[p].label} — ${SESSION_PROFILES[p].windows.map((w) => `${w.name} ${w.from}–${w.to}`).join(', ')} ET`}
                  onChange={(v) => set('sessionProfile', v)} />
              </Row>
            </Panel>

            <Panel title="Dealing range" code="TRADER INPUT · BROWSER CALC" data-testid="plan-range">
              <Row>
                <Field id="range-high" label="RANGE HIGH" value={draft.rangeHigh} onChange={(v) => set('rangeHigh', v)} />
                <Field id="range-low" label="RANGE LOW" value={draft.rangeLow} onChange={(v) => set('rangeLow', v)} />
              </Row>
              {range ? (
                <div style={{ ...CALC, display: 'grid', gap: 4 }} data-testid="plan-range-calc">
                  <span>PREMIUM {px(range.eq)} – {px(range.high)}</span>
                  <span style={{ color: 'var(--text-primary)' }}>EQ {px(range.eq)}</span>
                  <span>DISCOUNT {px(range.low)} – {px(range.eq)}</span>
                  <span style={NOTE}>EQ is the midpoint, (high + low) ÷ 2. Arithmetic on your two numbers, nothing else.</span>
                </div>
              ) : (
                <div style={NOTE}>Enter the high and the low to compute EQ, premium and discount. Optional; not on the checklist.</div>
              )}
            </Panel>
          </div>

          <Panel title="Key levels" code="TRADER INPUT · BROWSER CALC" data-testid="plan-levels"
            actions={<button type="button" style={BUTTON} onClick={() => setDraft((d) => ({ ...d, levels: [...d.levels, { label: '', price: '', type: '', liquidity: '', status: '' }] }))}>+ Add level</button>}>
            {draft.levels.length === 0 && <div style={NOTE}>No levels mapped yet. Add the levels you will trade from and into.</div>}
            {draft.levels.map((l, i) => {
              const price = Number(l.price)
              const zone = range && l.price.trim() !== '' && Number.isFinite(price) ? zoneOf(price, range) : null
              return (
                <Row key={i}>
                  <Field id={`lvl-${i}-label`} label={`LEVEL ${i + 1} LABEL`} value={l.label} onChange={(v) => setLevel(i, { label: v })} width={150} />
                  <Field id={`lvl-${i}-price`} label={`LEVEL ${i + 1} PRICE`} value={l.price} onChange={(v) => setLevel(i, { price: v })} width={100} />
                  <Choice id={`lvl-${i}-type`} label={`LEVEL ${i + 1} TYPE`} value={l.type} options={LEVEL_TYPES} onChange={(v) => setLevel(i, { type: v })} />
                  <Choice id={`lvl-${i}-liq`} label={`LEVEL ${i + 1} LIQUIDITY`} value={l.liquidity} options={LIQUIDITY} onChange={(v) => setLevel(i, { liquidity: v })} render={(v) => v.toLowerCase()} />
                  <Choice id={`lvl-${i}-status`} label={`LEVEL ${i + 1} STATUS`} value={l.status} options={LEVEL_STATUSES} onChange={(v) => setLevel(i, { status: v })} render={(v) => v.toLowerCase()} />
                  <span style={{ ...CALC, fontSize: 10, minWidth: 90, paddingBottom: 8 }} title="Against the dealing range above">{zone ? zone.replace('_', ' ') : '—'}</span>
                  <button type="button" style={{ ...BUTTON, color: 'var(--text-secondary)' }} onClick={() => setDraft((d) => ({ ...d, levels: d.levels.filter((_, j) => j !== i) }))}>Remove</button>
                </Row>
              )
            })}
          </Panel>

          <Panel title="Scenarios" code="TRADER INPUT">
            <div className="prep-grid prep-grid--three">
              {SCENARIO_KEYS.map((k) => {
                const name = SCENARIO_LABELS[k].toUpperCase()
                const s = draft.scenarios[k]
                return (
                  <div key={k} data-testid={`scenario-${k}`} style={{ border: '1px solid var(--border)', borderRadius: 3, padding: 10, background: 'var(--bg-secondary)' }}>
                    <div style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>{name}</div>
                    <Field id={`${k}-if`} label={`${name} IF`} value={s.if} onChange={(v) => setScenario(k, { if: v })} multiline width={0} />
                    <div style={{ height: 6 }} />
                    <Field id={`${k}-then`} label={`${name} THEN`} value={s.then} onChange={(v) => setScenario(k, { then: v })} multiline width={0} />
                    <div style={{ height: 6 }} />
                    <Field id={`${k}-inv`} label={k === 'noTrade' ? `${name} CANCEL CONDITION` : `${name} INVALIDATION`} value={s.invalidation} onChange={(v) => setScenario(k, { invalidation: v })} width={0} />
                    <div style={{ height: 6 }} />
                    <Field id={`${k}-opp`} label={`${name} OPPOSING LIQUIDITY`} value={s.opposingLiquidity} onChange={(v) => setScenario(k, { opposingLiquidity: v })} width={0}
                      placeholder={k === 'noTrade' ? 'optional' : undefined} />
                    <div style={{ height: 6 }} />
                    <Field id={`${k}-tgt`} label={`${name} TARGETS`} value={s.targets} onChange={(v) => setScenario(k, { targets: v })} width={0}
                      placeholder={k === 'noTrade' ? 'optional' : undefined} />
                  </div>
                )
              })}
            </div>
          </Panel>

          <div className="prep-grid">
            <Panel title="Scheduled events" code="TRADER INPUT · BROWSER CALC" data-testid="plan-events"
              actions={<button type="button" style={BUTTON} onClick={() => setDraft((d) => ({ ...d, events: [...d.events, { time: '', name: '', before: '', after: '' }] }))}>+ Add event</button>}>
              <div style={{ ...NOTE, marginBottom: 8 }}>
                Your own list and your own stand-aside policy. Nothing here comes from a calendar feed and nothing is
                pre-filled. Inside a window the ticket fails EVENT_STAND_ASIDE.
              </div>
              <Row>
                <Field id="events-checked" label="CALENDAR CHECKED (WHERE)" value={draft.eventsChecked} onChange={(v) => set('eventsChecked', v)}
                  placeholder="where you looked — required even when nothing is scheduled" width={260} />
              </Row>
              {draft.events.map((e, i) => {
                const w = eventWindow({ time: e.time.trim(), name: e.name, beforeMin: e.before.trim() === '' ? null : Number(e.before), afterMin: e.after.trim() === '' ? null : Number(e.after) })
                return (
                  <Row key={i}>
                    <Field id={`ev-${i}-time`} label={`EVENT ${i + 1} TIME (ET)`} value={e.time} onChange={(v) => setEvent(i, { time: v })} placeholder="HH:MM" width={90} />
                    <Field id={`ev-${i}-name`} label={`EVENT ${i + 1} NAME`} value={e.name} onChange={(v) => setEvent(i, { name: v })} width={140} />
                    <Field id={`ev-${i}-before`} label={`EVENT ${i + 1} MIN BEFORE`} value={e.before} onChange={(v) => setEvent(i, { before: v })} width={90} />
                    <Field id={`ev-${i}-after`} label={`EVENT ${i + 1} MIN AFTER`} value={e.after} onChange={(v) => setEvent(i, { after: v })} width={90} />
                    <span style={{ ...CALC, fontSize: 10, minWidth: 110, paddingBottom: 8 }}>
                      {w && w.end > w.start ? `ASIDE ${clock(w.start)}–${clock(w.end)}` : '—'}
                    </span>
                    <button type="button" style={{ ...BUTTON, color: 'var(--text-secondary)' }} onClick={() => setDraft((d) => ({ ...d, events: d.events.filter((_, j) => j !== i) }))}>Remove</button>
                  </Row>
                )
              })}
            </Panel>

            <Panel title="Daily limits" code="TRADER INPUT">
              <Row>
                <Field id="loss-limit" label="DAILY LOSS LIMIT ($)" value={draft.lossLimit} onChange={(v) => set('lossLimit', v)} width={150} />
                <Field id="max-attempts" label="MAX ATTEMPTS" value={draft.maxAttempts} onChange={(v) => set('maxAttempts', v)} width={110} />
              </Row>
              <div style={NOTE}>
                Required, with no default. When the journal&apos;s realized loss for {today} reaches the limit, or its attempts
                reach the maximum, the ticket fails DAILY_LOCK_ACTIVE.
                {todays && todays.amendments.length > 0 && (() => {
                  const s = strictestLimits(todays)
                  return <> The ticket reads the strictest written today: limit {s.lossLimit === null ? 'not written' : usd(s.lossLimit)}, maximum {s.maxAttempts ?? 'not written'}.</>
                })()}
              </div>
            </Panel>
          </div>

          <div className="card" style={{ padding: 12, marginBottom: 16, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" onClick={save} disabled={!!store.error}
              style={{ ...BUTTON, color: store.error ? 'var(--text-muted)' : 'var(--brand)', fontWeight: 700, fontSize: 12, padding: '7px 14px' }}>
              {todays === null ? 'Save plan' : frozen ? 'Record amendment' : 'Save plan'}
            </button>
            {parsed.errors.length > 0 && (
              <ul data-testid="plan-errors" style={{ margin: 0, paddingLeft: 18, color: '#fca5a5', fontSize: 12 }}>
                {parsed.errors.map((e) => <li key={e}>{e}</li>)}
              </ul>
            )}
            {msg && <span data-testid="plan-msg" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{msg}</span>}
            <Link href="/ticket" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--brand)' }}>Trade ticket →</Link>
          </div>

          {todays && todays.amendments.length > 0 && (
            <Panel title="Amendments" code="THIS BROWSER" data-testid="plan-amendments">
              <div style={{ ...NOTE, marginBottom: 6 }}>
                Recorded after the first taken trade on {today}. The plan as written before it is kept, unedited.
              </div>
              {todays.amendments.map((a, i) => (
                <div key={a.at + i} style={{ ...CALC, fontSize: 11, padding: '3px 0', borderTop: '1px solid var(--border)' }}>
                  #{i + 1} · {new Date(a.at).toLocaleString()} · changed {a.changed.join(', ')}
                </div>
              ))}
            </Panel>
          )}
        </>
      )}

      <Panel title="Past plans" code="THIS BROWSER" data-testid="plan-past">
        {!store.ready && <div style={NOTE}>Reading stored plans…</div>}
        {store.ready && past.length === 0 && <div style={NOTE}>No earlier plans in this browser.</div>}
        {past.map((p) => <PastPlan key={p.date} plan={p} />)}
      </Panel>
    </div>
  )
}

function clock(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

function PastPlan({ plan }: { plan: DailyPlan }) {
  const b: PlanBody = effectiveBody(plan)
  const items = planChecklist(plan.body)
  const done = items.filter((i) => i.done).length
  return (
    <details style={{ borderTop: '1px solid var(--border)', padding: '6px 0' }} data-testid={`past-${plan.date}`}>
      <summary style={{ ...CALC, cursor: 'pointer' }}>
        {plan.date} · {b.htfBias ?? 'NEUTRAL'} · {b.instruments.join(', ') || 'no instruments'} · checklist {done}/{items.length}
        {plan.amendments.length ? ` · ${plan.amendments.length} amendment${plan.amendments.length === 1 ? '' : 's'}` : ''}
      </summary>
      <div style={{ ...NOTE, marginTop: 6 }}>
        {SCENARIO_KEYS.map((k) => (
          <div key={k}><strong>{SCENARIO_LABELS[k]}:</strong> IF {b.scenarios[k].if || '—'} → THEN {b.scenarios[k].then || '—'}</div>
        ))}
        <div>Levels: {b.levels.map((l) => `${l.label || '?'} ${l.price ?? '?'} (${l.type ?? '?'})`).join(' · ') || '—'}</div>
        <div>Limit {b.lossLimit === null ? '—' : usd(b.lossLimit)} · max attempts {b.maxAttempts ?? '—'}</div>
      </div>
    </details>
  )
}
