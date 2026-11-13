'use client'
import Link from 'next/link'
import type { CSSProperties, ReactNode } from 'react'
import { Panel } from '@/components/hud/Panel'
import { GexMini } from '@/components/desk/GexMini'
import { TICKET_STATE_STYLE } from '@/components/ticket/stateStyle'
import { SESSION_TONE, describeSession, etClock, useMarketSession, type MarketSession } from '@/lib/marketSession'
import { useJournal } from '@/lib/journalStore'
import { usePlans } from '@/lib/dailyPlanStore'
import {
  SCENARIO_KEYS, SCENARIO_LABELS, dayRisk, dealingRange, effectiveBody, eventClock, isFrozen,
  planChecklist, planContextFor, planDateFrom, planWindows, zoneOf,
  type DailyPlan, type DayRisk,
} from '@/lib/dailyPlan'
import { deskLock, latestTicket, minutesText, type DeskLock } from '@/lib/desk'
import { SESSION_PROFILES, STOP_OUT_LOCK, minutesOf, sessionGate, type PlanContext } from '@/lib/tradeTicket'
import type { JournalEntry } from '@/lib/journal'
import type { Panel as PanelState } from '@/lib/panel'
import type { SourceState, SourceSummary } from '@/lib/sourceSummary'

/**
 * The desk: one screen for the God's Plan day — the session, today's plan,
 * the day's risk, the latest ticket, delayed GEX references and the sources.
 *
 * It computes nothing new. Every figure is read from a module that already
 * owns it — the session from `/api/health`, the plan and the journal from this
 * browser's storage, the GEX levels from `/api/gex` — and every panel names
 * where its numbers come from and says plainly when it has none.
 */

const MONO = "'JetBrains Mono', monospace"
const NOTE: CSSProperties = { fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.55 }
const KV: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 10, padding: '4px 0', borderTop: '1px solid var(--border)', fontSize: 12 }
const K: CSSProperties = { color: 'var(--text-muted)', fontSize: 11 }
const V: CSSProperties = { fontFamily: MONO, color: 'var(--text-primary)', textAlign: 'right' }
const LINK: CSSProperties = { color: 'var(--brand)', fontSize: 11, textDecoration: 'none' }

const usd = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const px = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 6 })

function Row({ k, children, testId }: { k: string; children: ReactNode; testId?: string }) {
  return <div style={KV} data-testid={testId}><span style={K}>{k}</span><span style={V}>{children}</span></div>
}

export default function DeskPage() {
  const { panel, sources } = useMarketSession()
  const session = panel.status === 'ok' ? panel.data : null
  const today = planDateFrom(session)
  const store = usePlans()
  const journal = useJournal()
  const journalOk = journal.ready && !journal.error
  const plan = today ? store.plans.find((p) => p.date === today) ?? null : null
  const ctx = planContextFor(
    today,
    { ready: store.ready, error: store.error, items: store.plans },
    { ready: journal.ready, error: journal.error, items: journal.entries },
  )
  const day = today && journalOk ? dayRisk(journal.entries, today) : null
  const lock = deskLock(today, day ? day.stopOuts : null, ctx)

  return (
    <div>
      <div style={{ marginBottom: 14, display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>◫ Desk</h1>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Plan → ticket → journal → review, on one screen. Every panel names its source; nothing here places an order.
        </span>
      </div>

      <div className="desk-grid">
        <SessionPanel session={session} status={panel.status} today={today} plan={plan} />
        <RiskPanel today={today} journalReady={journal.ready} journalError={journal.error} day={day} ctx={ctx} lock={lock} />
        <TicketPanel entries={journalOk ? journal.entries : null} ready={journal.ready} />
        <PlanPanel today={today} ready={store.ready} error={store.error} plan={plan} entries={journalOk ? journal.entries : null} />
        <Panel title="GEX reference" code="CBOE · DELAYED · MODELLED" className="desk-span-5" data-testid="desk-gex">
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 14 }}>
            <GexMini symbol="SPY" />
            <GexMini symbol="QQQ" />
          </div>
          <div style={{ ...NOTE, marginTop: 8 }}>
            Each ETF&apos;s own delayed chain. Modelled: GEX assumes a dealer position open interest does not show.
            Context only — never a gate.
          </div>
        </Panel>
        <SourcesPanel sources={sources} />
      </div>
    </div>
  )
}

// ─── Session ───────────────────────────────────────────────────────────────

function SessionPanel({ session, status, today, plan }: {
  session: MarketSession | null; status: PanelState<unknown>['status']; today: string | null; plan: DailyPlan | null
}) {
  const d = describeSession(session)
  const now = session?.nowMinutesEt ?? null
  const body = plan ? effectiveBody(plan) : null
  const windows = plan ? planWindows(plan) : []
  const ev = now !== null && Number.isFinite(now) ? eventClock(windows, now) : null
  const profile = body?.sessionProfile ? SESSION_PROFILES[body.sessionProfile] : null
  // The window verdict is the ticket's own session gate, so the desk cannot
  // call a window live on a weekend or past a half day's close.
  const gate = body?.sessionProfile ? sessionGate(body.sessionProfile, session) : null
  return (
    <Panel title="Session" code="BACKEND CLOCK" className="desk-span-3" data-testid="desk-session">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }} title={d.detail}>
        <span className="hud-dot" style={{ background: SESSION_TONE[d.tone] }} aria-hidden="true" />
        <span data-testid="desk-session-label" style={{ fontFamily: MONO, fontWeight: 700, fontSize: 14, color: SESSION_TONE[d.tone] }}>{d.label}</span>
      </div>
      <Row k="ET clock (backend)" testId="desk-clock">{now === null ? '—' : `${etClock(now)} ET`}</Row>
      <Row k="Trading date" testId="desk-date">{today ?? (status === 'loading' ? 'waiting…' : 'unknown')}</Row>
      <Row k="RTH hours">{session?.openMinutesEt != null && session?.closeMinutesEt != null ? `${etClock(session.openMinutesEt)}–${etClock(session.closeMinutesEt)} ET` : '—'}</Row>
      {profile && (
        <div style={{ ...KV, display: 'block' }}>
          <span style={K}>Plan profile · {profile.label}</span>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
            {profile.windows.map((w) => {
              const on = gate?.status === 'PASS' && now !== null && now >= minutesOf(w.from) && now < minutesOf(w.to)
              return (
                <span key={w.name} style={{ fontFamily: MONO, fontSize: 10, padding: '1px 6px', borderRadius: 2, border: '1px solid var(--border-light)',
                  color: on ? 'var(--text-primary)' : 'var(--text-muted)', fontWeight: on ? 700 : 400 }}>
                  {w.name} {w.from}–{w.to}{on ? ' · NOW' : ''}
                </span>
              )
            })}
          </div>
          {gate && (
            <div data-testid="desk-window" style={{ fontSize: 11, marginTop: 4, color: gate.status === 'PASS' ? '#86efac' : gate.status === 'FAIL' ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
              {gate.status === 'PASS' ? 'IN WINDOW' : gate.status === 'FAIL' ? 'OUTSIDE WINDOW' : 'WINDOW UNKNOWN'} · {gate.detail}
            </div>
          )}
        </div>
      )}
      <div style={{ ...KV, display: 'block' }} data-testid="desk-next-event">
        <span style={K}>Next stand-aside</span>
        <div style={{ fontFamily: MONO, fontSize: 12, marginTop: 3 }}>
          {!plan ? <span style={K}>No plan, so no declared events.</span>
            : windows.length === 0 ? <span style={K}>No events declared in today&apos;s plan.</span>
              : ev === null ? <span style={K}>ET clock unknown — cannot count down.</span>
                : <>
                  {ev.inside.map((w) => (
                    <div key={w.name + w.start} style={{ color: '#fca5a5' }}>STAND ASIDE NOW · {w.name} until {etClock(w.end)} ET</div>
                  ))}
                  {ev.next
                    ? <div style={{ color: 'var(--text-primary)' }}>{ev.next.window.name} {ev.next.window.time} ET · aside from {etClock(ev.next.window.start)} · in {minutesText(ev.next.minutesToStart)}</div>
                    : ev.inside.length === 0 && <span style={K}>No stand-aside window left today.</span>}
                </>}
        </div>
      </div>
      <div style={{ ...NOTE, marginTop: 6 }}>RTH only; the clock is the backend&apos;s, refreshed each minute.</div>
    </Panel>
  )
}

// ─── Risk ──────────────────────────────────────────────────────────────────

const LOCK_COLOR: Record<DeskLock['state'], string> = { LOCKED: '#ef4444', CLEAR: '#22c55e', UNKNOWN: '#a1a1aa' }

function RiskPanel({ today, journalReady, journalError, day, ctx, lock }: {
  today: string | null; journalReady: boolean; journalError: string | null; day: DayRisk | null; ctx: PlanContext; lock: DeskLock
}) {
  const limit = ctx.status === 'WRITTEN' ? ctx.lossLimit : null
  const max = ctx.status === 'WRITTEN' ? ctx.maxAttempts : null
  const pct = limit !== null && day ? Math.min(100, (day.realizedLoss / limit) * 100) : null
  return (
    <Panel title="Risk state" code="JOURNAL · THIS BROWSER" className="desk-span-5" data-testid="desk-risk">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
        <span data-testid="desk-lock" style={{ fontFamily: MONO, fontWeight: 800, fontSize: 16, color: LOCK_COLOR[lock.state] }}>{lock.state}</span>
        <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>daily lock, as measured here</span>
      </div>
      <ul data-testid="desk-lock-reasons" style={{ margin: '0 0 8px', paddingLeft: 16, fontSize: 11, color: lock.state === 'LOCKED' ? '#fca5a5' : 'var(--text-muted)' }}>
        {lock.reasons.map((r) => <li key={r}>{r}</li>)}
      </ul>
      {today === null ? <div style={NOTE}>Today&apos;s date is unknown, so no figure for today can be read.</div>
        : !journalReady ? <div style={NOTE}>Reading the journal…</div>
          : journalError || !day ? <div style={NOTE}>The journal could not be read: {journalError}</div>
            : (
              <>
                <Row k={`Realized P&L ${today}`} testId="desk-pnl">
                  <span style={{ color: day.realizedPnl > 0 ? '#22c55e' : day.realizedPnl < 0 ? '#ef4444' : 'var(--text-primary)' }}>
                    {day.closed === 0 ? 'no trade closed' : usd(day.realizedPnl)}
                  </span>
                </Row>
                <Row k="Realized R (measured)" testId="desk-r">
                  {day.realizedR === null ? '—' : `${day.realizedR >= 0 ? '+' : ''}${day.realizedR.toFixed(2)}R over ${day.measuredR}`}
                </Row>
                <div style={{ ...KV, display: 'block' }} data-testid="desk-loss-bar">
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={K}>Loss vs written limit</span>
                    <span style={V}>{usd(day.realizedLoss)} / {limit === null ? 'not written' : usd(limit)}</span>
                  </div>
                  {pct !== null && (
                    <div role="meter" aria-label="Realized loss against the written daily limit" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}
                      style={{ height: 6, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 2, marginTop: 4 }}>
                      <div style={{ width: `${pct}%`, height: '100%', background: pct >= 100 ? '#ef4444' : '#fbbf24' }} />
                    </div>
                  )}
                </div>
                <Row k="Stop-outs" testId="desk-stopouts">{day.stopOuts} / {STOP_OUT_LOCK}</Row>
                <Row k="Attempts" testId="desk-attempts">{day.attempts} / {max ?? 'max not written'}</Row>
                {(day.lossesWithoutFees > 0 || day.winsWithoutFees > 0 || day.unmeasurable > 0) && (
                  <div style={{ ...NOTE, marginTop: 4 }}>
                    {day.lossesWithoutFees > 0 && `${day.lossesWithoutFees} loss(es) without fees count at gross (the loss is at least this). `}
                    {day.winsWithoutFees > 0 && `${day.winsWithoutFees} win(s) without fees are left out until fees are entered. `}
                    {day.unmeasurable > 0 && `${day.unmeasurable} closed trade(s) have exits that do not cover the fill and are not counted.`}
                  </div>
                )}
              </>
            )}
      <div style={{ ...NOTE, marginTop: 6 }}>
        Net of fees where entered. <Link href="/journal" style={LINK}>Journal →</Link>
      </div>
    </Panel>
  )
}

// ─── Ticket ────────────────────────────────────────────────────────────────

function TicketPanel({ entries, ready }: { entries: readonly JournalEntry[] | null; ready: boolean }) {
  const latest = entries ? latestTicket(entries) : null
  const t = latest?.ticket
  const style = t ? TICKET_STATE_STYLE[t.state] : null
  return (
    <Panel title="Latest ticket" code="JOURNAL · AS SAVED" className="desk-span-4" data-testid="desk-ticket">
      {!ready ? <div style={NOTE}>Reading the journal…</div>
        : entries === null ? <div style={NOTE}>The journal could not be read, so no saved ticket is shown.</div>
          : !t || !style ? (
            <div style={NOTE} data-testid="desk-ticket-empty">
              No ticket saved in this browser yet. Fill a ticket and use &ldquo;Save to journal&rdquo; — blocked ideas count too.
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
                <span data-testid="desk-ticket-state" style={{ fontFamily: MONO, fontWeight: 800, fontSize: 12, color: style.color, background: style.bg, padding: '3px 10px', borderRadius: 3 }}>{style.label}</span>
                <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-primary)' }}>{t.setupId}</span>
              </div>
              <Row k="Instrument">{t.contract ?? t.symbol} · {t.direction ?? '—'}</Row>
              <Row k="Journal status">{latest!.status}</Row>
              <Row k="Saved">{new Date(latest!.savedAt).toLocaleString()}</Row>
              {t.blockers.length > 0 && (
                <ul data-testid="desk-ticket-blockers" style={{ margin: '6px 0 0', paddingLeft: 16, fontSize: 11, color: '#fca5a5' }}>
                  {t.blockers.map((b) => <li key={b.code}><code style={{ fontFamily: MONO }}>{b.code}</code></li>)}
                </ul>
              )}
              {t.state !== 'NEUTRAL' && t.waiting.length > 0 && (
                <div style={{ ...NOTE, color: '#fcd34d', marginTop: 4 }}>{t.waiting.length} item{t.waiting.length === 1 ? '' : 's'} were still waiting when saved.</div>
              )}
              <div style={{ ...NOTE, marginTop: 6 }}>As saved: a journaled ticket is frozen, not re-evaluated.</div>
            </>
          )}
      <div style={{ marginTop: 6 }}><Link href="/ticket" style={LINK}>New ticket →</Link></div>
    </Panel>
  )
}

// ─── Plan ──────────────────────────────────────────────────────────────────

const BIAS_COLOR = { BULLISH: '#22c55e', BEARISH: '#ef4444' } as const

function PlanPanel({ today, ready, error, plan, entries }: {
  today: string | null; ready: boolean; error: string | null; plan: DailyPlan | null; entries: readonly JournalEntry[] | null
}) {
  if (today === null || !ready || error || !plan) {
    return (
      <Panel title="Today's plan" code="THIS BROWSER" className="desk-span-7" data-testid="desk-plan">
        <div style={NOTE} data-testid="desk-plan-empty">
          {today === null ? "Today's trading date is unknown (the backend has not answered), so no plan can be matched to it."
            : !ready ? 'Reading stored plans…'
              : error ? `The stored plans could not be read: ${error}`
                : `No plan written for ${today}. The trade ticket waits on PLAN_NOT_WRITTEN until it is written and complete.`}
        </div>
        {today !== null && <div style={{ marginTop: 8 }}><Link href="/prep" style={LINK}>Write today&apos;s plan →</Link></div>}
      </Panel>
    )
  }
  const b = effectiveBody(plan)
  const items = planChecklist(plan.body)
  const done = items.filter((i) => i.done).length
  const range = dealingRange(b.range.high, b.range.low)
  const frozen = isFrozen(plan, entries)
  return (
    <Panel title="Today's plan" code="TRADER INPUT · THIS BROWSER" className="desk-span-7" data-testid="desk-plan"
      status={<span style={{ fontFamily: MONO, fontSize: 10, color: 'var(--text-muted)' }}>{plan.date}{frozen ? ' · FROZEN' : ''}{plan.amendments.length ? ` · ${plan.amendments.length} AMENDMENT${plan.amendments.length === 1 ? '' : 'S'}` : ''}</span>}>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'baseline', marginBottom: 8 }}>
        <span style={{ fontFamily: MONO, fontSize: 12 }}>
          <span style={K}>HTF BIAS </span>
          <strong data-testid="desk-plan-bias" style={{ color: b.htfBias ? BIAS_COLOR[b.htfBias] : '#a1a1aa' }}>{b.htfBias ?? 'NEUTRAL'}</strong>
        </span>
        <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-secondary)' }}>
          <span style={K}>FOCUS </span>{b.instruments.join(' · ') || '—'}
        </span>
        <span data-testid="desk-plan-checklist" style={{ fontFamily: MONO, fontSize: 12, color: done === items.length ? '#22c55e' : '#fbbf24' }}>
          CHECKLIST {done}/{items.length}{done === items.length ? ' COMPLETE' : ''}
        </span>
        {range && <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-secondary)' }}><span style={K}>EQ </span>{px(range.eq)} <span style={K}>({px(range.low)}–{px(range.high)})</span></span>}
      </div>
      {done < items.length && (
        <div style={{ fontSize: 11, color: '#fcd34d', marginBottom: 8 }}>
          Missing: {items.filter((i) => !i.done).map((i) => i.label).join(' · ')}
        </div>
      )}
      <div className="desk-scenarios">
        {SCENARIO_KEYS.map((k) => {
          const s = b.scenarios[k]
          return (
            <div key={k} data-testid={`desk-scenario-${k}`} style={{ border: '1px solid var(--border)', borderRadius: 3, padding: '8px 10px', background: 'var(--bg-secondary)', minWidth: 0 }}>
              <div style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', letterSpacing: '0.08em', marginBottom: 4 }}>{SCENARIO_LABELS[k].toUpperCase()}</div>
              <div style={{ fontSize: 12, color: 'var(--text-primary)' }}><span style={K}>IF </span>{s.if || '—'}</div>
              <div style={{ fontSize: 12, color: 'var(--text-primary)' }}><span style={K}>THEN </span>{s.then || '—'}</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}><span style={K}>{k === 'noTrade' ? 'CANCEL ' : 'INVALID '}</span>{s.invalidation || '—'}</div>
              {k !== 'noTrade' && <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}><span style={K}>TARGETS </span>{s.targets || '—'}</div>}
            </div>
          )
        })}
      </div>
      <table className="desk-levels" data-testid="desk-levels">
        <thead><tr><th>LEVEL</th><th>PRICE</th><th>TYPE</th><th>LIQ</th><th>STATUS</th><th>ZONE</th></tr></thead>
        <tbody>
          {b.levels.length === 0 && <tr><td colSpan={6} style={{ color: 'var(--text-muted)' }}>No levels mapped.</td></tr>}
          {b.levels.slice(0, 8).map((l, i) => (
            <tr key={i} style={{ opacity: l.status === 'INVALIDATED' ? 0.6 : 1 }}>
              <td>{l.label || '—'}</td>
              <td>{l.price === null ? '—' : px(l.price)}</td>
              <td>{l.type ?? '—'}</td>
              <td>{l.liquidity === null ? '—' : l.liquidity === 'EXTERNAL' ? 'ext' : 'int'}</td>
              <td>{l.status?.toLowerCase() ?? '—'}</td>
              <td>{range && l.price !== null ? zoneOf(l.price, range).replace('_', ' ').toLowerCase() : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {b.levels.length > 8 && <div style={NOTE}>{b.levels.length - 8} more on the plan.</div>}
      <div style={{ marginTop: 8 }}><Link href="/prep" style={LINK}>Open the plan →</Link></div>
    </Panel>
  )
}

// ─── Sources ───────────────────────────────────────────────────────────────

const SOURCE_STYLE: Record<SourceState, { label: string; color: string }> = {
  connected: { label: 'CONNECTED', color: '#86efac' },
  degraded: { label: 'DEGRADED', color: '#fde68a' },
  error: { label: 'ERROR', color: '#fca5a5' },
  refused: { label: 'REFUSED', color: '#d4d4d8' },
  disabled: { label: 'OFF', color: '#a1a1aa' },
  unknown: { label: 'UNKNOWN', color: '#a1a1aa' },
}
const SOURCE_ORDER: SourceState[] = ['connected', 'degraded', 'error', 'refused', 'disabled', 'unknown']

function SourcesPanel({ sources }: { sources: PanelState<SourceSummary | null> }) {
  return (
    <Panel title="Sources" code="API HEALTH" className="desk-span-12" data-testid="desk-sources">
      {sources.status === 'loading' && <div style={NOTE}>Waiting for /api/health…</div>}
      {sources.status === 'unreachable' && <div style={NOTE}>The backend did not answer /api/health, so no source status is known.</div>}
      {sources.status === 'unauthorized' && <div style={NOTE}>The backend refused this session for /api/health.</div>}
      {sources.status === 'ok' && sources.data === null && <div style={NOTE}>The backend answered without a source list.</div>}
      {sources.status === 'ok' && sources.data !== null && (
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'baseline' }}>
          {SOURCE_ORDER.filter((s) => sources.data!.byState[s].length > 0).map((s) => (
            <span key={s} style={{ fontSize: 11 }}>
              <strong style={{ fontFamily: MONO, color: SOURCE_STYLE[s].color }}>{sources.data!.byState[s].length} {SOURCE_STYLE[s].label}</strong>{' '}
              <span style={{ color: 'var(--text-muted)' }}>{sources.data!.byState[s].join(', ')}</span>
            </span>
          ))}
          {sources.data.simulation && (
            <span style={{ fontFamily: MONO, fontSize: 11, color: '#c4b5fd' }} title="The backend is generating simulated prints. They are labelled SYN per row and never enter the track record.">
              SIMULATOR ON
            </span>
          )}
          <Link href="/settings" style={{ ...LINK, marginLeft: 'auto' }}>Settings →</Link>
        </div>
      )}
    </Panel>
  )
}
