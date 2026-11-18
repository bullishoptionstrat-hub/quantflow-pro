'use client'
import Link from 'next/link'
import type { CSSProperties } from 'react'
import { Panel } from '@/components/hud/Panel'
import { etClock } from '@/lib/marketSession'
import { eventClock } from '@/lib/dailyPlan'
import type { PlanContext } from '@/lib/tradeTicket'

/**
 * Today's daily plan as the ticket reads it: whether it is written, what its
 * checklist is missing, and the figures behind the two tightenings it can
 * make — the written loss limit and attempts against this browser's journal,
 * and the event stand-aside windows on the backend's ET clock.
 *
 * Display only: the gates on the ticket are computed from the same context by
 * `evaluateTicket`, not from anything here.
 */

const MONO = "'JetBrains Mono', monospace"
const NOTE: CSSProperties = { fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }
const ROW: CSSProperties = { display: 'flex', gap: 10, flexWrap: 'wrap', fontFamily: MONO, fontSize: 12, color: 'var(--text-secondary)', padding: '4px 0' }

const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function PlanContextPanel({ plan, nowMinutesEt }: { plan: PlanContext; nowMinutesEt: number | null }) {
  return (
    <Panel title="Daily plan" code="THIS BROWSER · BROWSER CALC" data-testid="ticket-plan">
      {plan.status === 'UNAVAILABLE' && (
        <div style={NOTE} data-testid="ticket-plan-status">PLAN UNKNOWN — {plan.reason}</div>
      )}
      {plan.status === 'NOT_WRITTEN' && (
        <div style={{ ...NOTE, color: '#fcd34d' }} data-testid="ticket-plan-status">
          NO PLAN for {plan.date} (ET, the backend&apos;s date). The ticket waits on PLAN_NOT_WRITTEN until one is written
          and complete. <Link href="/prep" style={{ color: 'var(--brand)' }}>Write today&apos;s plan →</Link>
        </div>
      )}
      {plan.status === 'WRITTEN' && (
        <>
          <div data-testid="ticket-plan-status" style={{ ...NOTE, color: plan.missing.length ? '#fcd34d' : '#86efac' }}>
            {plan.missing.length
              ? `PLAN ${plan.date} INCOMPLETE — ${plan.missing.length} item${plan.missing.length === 1 ? '' : 's'} missing.`
              : `PLAN ${plan.date} WRITTEN — checklist complete.`}{' '}
            <Link href="/prep" style={{ color: 'var(--brand)' }}>Open the plan →</Link>
          </div>
          {plan.missing.length > 0 && (
            <ul style={{ margin: '4px 0 6px', paddingLeft: 18, color: '#fcd34d', fontSize: 12 }}>
              {plan.missing.map((m) => <li key={m}>{m}</li>)}
            </ul>
          )}
          <div style={ROW} data-testid="ticket-plan-limits">
            <span>
              LOSS {plan.day ? usd(plan.day.realizedLoss) : '—'} / LIMIT {plan.lossLimit === null ? 'not written' : usd(plan.lossLimit)}
              {plan.day && plan.day.lossesWithoutFees > 0 ? ` (at least; ${plan.day.lossesWithoutFees} without fees)` : ''}
            </span>
            <span>ATTEMPTS {plan.day ? plan.day.attempts : '—'} / MAX {plan.maxAttempts ?? 'not written'}</span>
          </div>
          {plan.day === null && (
            <div style={NOTE}>The journal could not be read, so today&apos;s loss and attempts are unknown and tighten nothing.</div>
          )}
          <EventLine plan={plan} now={nowMinutesEt} />
        </>
      )}
      <div style={{ ...NOTE, marginTop: 6 }}>
        The plan passes only its own gate. Its loss limit and attempts can only fail the daily lock, and its event
        windows can only fail or hold the ticket; it never answers a gate you left open.
      </div>
    </Panel>
  )
}

function EventLine({ plan, now }: { plan: Extract<PlanContext, { status: 'WRITTEN' }>; now: number | null }) {
  if (plan.windows.length === 0) return <div style={ROW}>EVENTS none declared</div>
  if (now === null || !Number.isFinite(now)) {
    return <div style={ROW}>EVENTS {plan.windows.length} declared · ET clock unknown, so the stand-aside cannot be measured</div>
  }
  const c = eventClock(plan.windows, now)
  return (
    <div style={ROW} data-testid="ticket-plan-events">
      {c.inside.length > 0 && (
        <span style={{ color: '#fca5a5' }}>
          STAND ASIDE NOW · {c.inside.map((w) => `${w.name} until ${etClock(w.end)} ET`).join(', ')}
        </span>
      )}
      {c.next && (
        <span>NEXT {c.next.window.name} · stand aside from {etClock(c.next.window.start)} ET · in {c.next.minutesToStart} min</span>
      )}
      {c.inside.length === 0 && !c.next && <span>No stand-aside window left today</span>}
    </div>
  )
}
